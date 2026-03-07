import { Router } from 'express';
import conversations from '../services/conversations.js';
import slots from '../services/slots.js';
import { streamChatCompletion, parseSSEChunks } from '../services/llm.js';
import { getSystemPrompt, parseToolCall, executeTool } from '../services/tools.js';

const router = Router();

// List conversation summaries
router.get('/', (_req, res) => {
  res.json(conversations.list());
});

// Create conversation
router.post('/', (req, res) => {
  const conv = conversations.create(req.body.title);
  res.status(201).json(conv);
});

// Get conversation with messages
router.get('/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

// Delete conversation
router.delete('/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  slots.releaseSlot(req.params.id);
  conversations.remove(req.params.id);
  res.status(204).end();
});

// Update title
router.patch('/:id', (req, res) => {
  const conv = conversations.updateTitle(req.params.id, req.body.title);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

// Send message + stream response
router.post('/:id/messages', async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const content = (req.body.content || '').trim();
  const images = req.body.images; // [{ mimeType, base64 }]
  if (!content && (!images || images.length === 0)) {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Store user message — structured content when images are present
  const storedContent = images && images.length > 0
    ? { text: content, images }
    : content;
  conversations.addMessage(conv.id, 'user', storedContent);

  // Resolve slot
  let slotId = slots.getSlotForConversation(conv.id);
  if (slotId == null) slotId = slots.assignSlot(conv.id);
  if (slotId != null) conversations.setSlot(conv.id, slotId);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Add assistant placeholder
  const assistantMsg = conversations.addMessage(conv.id, 'assistant', '');
  const msgIndex = conv.messages.length - 1;

  const abortController = new AbortController();
  res.on('close', () => abortController.abort());

  try {
    // Build messages with system prompt for tool support
    const systemPrompt = getSystemPrompt();

    // Convert stored messages to OpenAI format (handle vision + structured assistant content)
    const historyMessages = conv.messages.slice(0, -1).map(msg => {
      if (msg.role === 'user' && typeof msg.content === 'object' && msg.content.images) {
        const parts = [];
        if (msg.content.text) {
          parts.push({ type: 'text', text: msg.content.text });
        }
        for (const img of msg.content.images) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
          });
        }
        return { role: 'user', content: parts };
      }
      if (msg.role === 'assistant' && typeof msg.content === 'object' && msg.content.text) {
        return { role: 'assistant', content: msg.content.text };
      }
      return msg;
    });

    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...historyMessages,
    ];

    // Stream one LLM round: forwards reasoning chunks to client in real-time,
    // buffers content for tool-call detection, returns { content, usage }.
    async function streamRound(messages, opts) {
      const response = await streamChatCompletion(messages, opts);
      let content = '';
      let usage = null;

      for await (const chunk of parseSSEChunks(response)) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.reasoning_content) {
          accumulatedReasoning += delta.reasoning_content;
          res.write(`data: ${JSON.stringify({ reasoning: delta.reasoning_content })}\n\n`);
        }
        if (delta?.content) {
          content += delta.content;
        }
        // Usage: llama-server sends timings, OpenAI sends usage
        const timings = chunk.timings || chunk.usage;
        if (timings) {
          const prompt = timings.prompt_n ?? timings.prompt_tokens ?? 0;
          const predicted = timings.predicted_n ?? timings.completion_tokens ?? 0;
          usage = { prompt_tokens: prompt, completion_tokens: predicted, total_tokens: prompt + predicted };
        }
      }

      return { content, usage };
    }

    const MAX_TOOL_ROUNDS = 5;
    let finalContent = '';
    let lastUsage = null;
    let accumulatedReasoning = '';
    const toolUses = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await streamRound(llmMessages, {
        slotId,
        signal: abortController.signal,
      });

      if (result.usage) lastUsage = result.usage;

      const toolCall = parseToolCall(result.content);
      if (toolCall) {
        const toolResult = await executeTool(toolCall.name, toolCall.arguments);
        // Send tool_use event to client and store for persistence
        toolUses.push({ name: toolCall.name, result: toolResult });
        res.write(`data: ${JSON.stringify({ tool_use: { name: toolCall.name, result: toolResult } })}\n\n`);
        // Append assistant tool call + tool result to messages for next round
        llmMessages.push({ role: 'assistant', content: result.content });
        llmMessages.push({ role: 'user', content: `Tool "${toolCall.name}" result: ${toolResult}` });
      } else {
        // Final answer — no tool call
        finalContent = result.content;
        break;
      }
    }

    // If tool loop exhausted without a final answer, force LLM to respond without tools
    if (!finalContent) {
      console.warn(`[tool-loop] no final content after ${MAX_TOOL_ROUNDS} rounds, forcing answer`);
      llmMessages.push({
        role: 'user',
        content: 'You have used all available tool rounds. Now provide your best answer using the information you have gathered so far. Do NOT call any tools.',
      });
      const forced = await streamRound(llmMessages, {
        slotId,
        signal: abortController.signal,
      });
      finalContent = forced.content;
      if (forced.usage) lastUsage = forced.usage;
    }

    // Send final content as a single event
    if (finalContent) {
      const stored = { text: finalContent };
      if (accumulatedReasoning) stored.reasoning = accumulatedReasoning;
      if (toolUses.length > 0) stored.toolUses = toolUses;
      conversations.updateMessageContent(conv.id, msgIndex, stored);
      res.write(`data: ${JSON.stringify({ content: finalContent })}\n\n`);
    }

    if (lastUsage) {
      conversations.setTokenCount(conv.id, lastUsage.total_tokens);
      res.write(`data: ${JSON.stringify({ usage: lastUsage })}\n\n`);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      const errMsg = err.message || 'LLM request failed';
      conversations.updateMessageContent(conv.id, msgIndex, `[Error: ${errMsg}]`);
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();

  // Auto-title from first user message
  const updated = conversations.get(conv.id);
  if (updated && updated.title === 'New conversation' && updated.messages.length >= 1) {
    const firstUser = updated.messages.find(m => m.role === 'user');
    if (firstUser) {
      const text = typeof firstUser.content === 'object'
        ? firstUser.content.text
        : firstUser.content;
      if (text) {
        const title = text.length > 60 ? text.slice(0, 60) + '…' : text;
        conversations.updateTitle(conv.id, title);
      }
    }
  }
});

export default router;
