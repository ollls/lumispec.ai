import { Router } from 'express';
import conversations from '../services/conversations.js';
import slots from '../services/slots.js';
import { collectChatCompletion } from '../services/llm.js';
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
  if (!content) return res.status(400).json({ error: 'Content is required' });

  // Add user message
  conversations.addMessage(conv.id, 'user', content);

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
    const llmMessages = [
      { role: 'system', content: systemPrompt },
      ...conv.messages.slice(0, -1), // exclude assistant placeholder
    ];

    const MAX_TOOL_ROUNDS = 5;
    let finalContent = '';
    let lastUsage = null;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await collectChatCompletion(llmMessages, {
        slotId,
        signal: abortController.signal,
      });

      if (result.usage) lastUsage = result.usage;

      const toolCall = parseToolCall(result.content);
      if (toolCall) {
        const toolResult = await executeTool(toolCall.name, toolCall.arguments);
        // Send tool_use event to client
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

    // Send final content as a single event
    if (finalContent) {
      conversations.updateMessageContent(conv.id, msgIndex, finalContent);
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
      const title = firstUser.content.length > 60
        ? firstUser.content.slice(0, 60) + '…'
        : firstUser.content;
      conversations.updateTitle(conv.id, title);
    }
  }
});

export default router;
