import { Router } from 'express';
import conversations from '../services/conversations.js';
import slots from '../services/slots.js';
import { streamChatCompletion, parseSSEChunks } from '../services/llm.js';
import { getSystemPrompt, parseToolCalls, executeTool, requestConfirmation, resolveConfirmation, cancelConfirmation } from '../services/tools.js';

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

// Confirm/deny a pending command
router.post('/:id/confirm', (req, res) => {
  const { approved } = req.body;
  const resolved = resolveConfirmation(req.params.id, !!approved);
  if (!resolved) return res.status(404).json({ error: 'No pending confirmation' });
  res.json({ ok: true });
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
  res.on('close', () => {
    abortController.abort();
    cancelConfirmation(conv.id);
  });

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
    // When isToolRound=true, streams content tokens as {tool_content} events for user feedback.
    async function streamRound(messages, opts, isToolRound = false) {
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
          // During tool rounds, stream content so user sees progress instead of dead screen
          if (isToolRound) {
            res.write(`data: ${JSON.stringify({ tool_content: delta.content })}\n\n`);
          }
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
    const MAX_SAME_TOOL_REPEATS = 2;
    const MAX_PARALLEL_TOOLS = 4;
    let finalContent = '';
    let lastUsage = null;
    let accumulatedReasoning = '';
    const toolUses = [];
    const toolCallCounts = {}; // track per-tool call counts
    let hadChainData = false;        // whether any optionchains call has completed
    const savedFiles = [];            // filenames from saveAs / auto-save results

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Stream content as tool_content so user sees progress during generation
      const result = await streamRound(llmMessages, {
        slotId,
        signal: abortController.signal,
      }, true);

      if (result.usage) lastUsage = result.usage;

      const toolCallsFound = parseToolCalls(result.content);
      if (toolCallsFound.length > 0) {
        // Check for repeated same-tool calls (prevents retry loops)
        for (const tc of toolCallsFound) {
          toolCallCounts[tc.name] = (toolCallCounts[tc.name] || 0) + 1;
        }
        const overLimit = toolCallsFound.filter(tc => toolCallCounts[tc.name] > MAX_SAME_TOOL_REPEATS);
        if (overLimit.length > 0) {
          console.warn(`[tool-loop] tool "${overLimit[0].name}" called ${toolCallCounts[overLimit[0].name]} times, breaking retry loop`);
          llmMessages.push({ role: 'assistant', content: result.content });
          llmMessages.push({
            role: 'user',
            content: `Tool "${overLimit[0].name}" has been called ${toolCallCounts[overLimit[0].name]} times. Stop retrying and provide your best answer using the results you have so far. If there was an error, explain what went wrong.`,
          });
          continue;
        }

        // Cap parallel tool calls to prevent context blowup from massive combined results
        if (toolCallsFound.length > MAX_PARALLEL_TOOLS) {
          console.warn(`[tool-loop] round ${round + 1}: capping ${toolCallsFound.length} tool calls to ${MAX_PARALLEL_TOOLS} (dropped: ${toolCallsFound.slice(MAX_PARALLEL_TOOLS).map(tc => tc.name).join(', ')})`);
          toolCallsFound.length = MAX_PARALLEL_TOOLS;
        }
        // Execute all tool calls in parallel
        const toolNames = toolCallsFound.map(tc => tc.name).join(', ');
        console.log(`[tool-loop] round ${round + 1}: executing ${toolCallsFound.length} tool(s): ${toolNames}`);
        const roundStart = Date.now();
        const context = {
          confirmFn: (command) => {
            res.write(`data: ${JSON.stringify({ confirm_command: { command } })}\n\n`);
            return requestConfirmation(conv.id, command);
          },
        };
        const results = await Promise.all(
          toolCallsFound.map(tc => executeTool(tc.name, tc.arguments, context))
        );
        console.log(`[tool-loop] round ${round + 1}: all tools finished in ${((Date.now() - roundStart) / 1000).toFixed(1)}s`);
        const resultParts = [];
        for (let i = 0; i < toolCallsFound.length; i++) {
          toolUses.push({ name: toolCallsFound[i].name, result: results[i] });
          res.write(`data: ${JSON.stringify({ tool_use: { name: toolCallsFound[i].name, result: results[i] } })}\n\n`);
          // Send clean data to LLM: compact summaries to minimize context bloat
          let llmResult = results[i];
          try {
            const parsed = JSON.parse(results[i]);
            if (parsed._autoSaved && parsed.savedFile) {
              // Large result auto-saved — send only summary + filename (no preview table)
              const { _markdown, ...summary } = parsed;
              llmResult = JSON.stringify(summary);
            } else if (parsed._markdown) {
              const { _markdown, ...summary } = parsed;
              // Truncate markdown tables to reduce context: keep header + first 10 data rows
              const mdLines = _markdown.split('\n');
              let truncatedMd = _markdown;
              const dataRowStart = mdLines.findIndex(l => l.startsWith('|')) + 2; // skip header + separator
              if (dataRowStart > 1) {
                const dataRows = mdLines.slice(dataRowStart).filter(l => l.startsWith('|'));
                if (dataRows.length > 10) {
                  truncatedMd = mdLines.slice(0, dataRowStart + 10).join('\n') + `\n... (${dataRows.length - 10} more rows)`;
                }
              }
              llmResult = truncatedMd + (Object.keys(summary).length ? '\n\n' + JSON.stringify(summary) : '');
            }
          } catch {}
          resultParts.push(`Tool "${toolCallsFound[i].name}" result: ${llmResult}`);
        }
        llmMessages.push({ role: 'assistant', content: result.content });
        const roundsLeft = MAX_TOOL_ROUNDS - round - 1;

        // Track chain completions and saved files
        for (const tc of toolCallsFound) {
          if (tc.arguments?.action === 'optionchains') hadChainData = true;
        }
        for (const r of results) {
          try {
            const p = JSON.parse(r);
            if (p.savedFile?.filename) savedFiles.push(p.savedFile.filename);
          } catch {}
        }

        // Directive: nudge LLM toward next step based on what's missing
        let directive = '';
        if (savedFiles.length > 0) {
          directive = `Data saved to: ${savedFiles.join(', ')}. Use run_python to analyze. Do NOT re-fetch data you already have.`;
        } else if (!hadChainData) {
          directive = 'NOW call optionchains (with saveAs and strikePriceNear) for the expiries you need. Do NOT re-fetch quote or optionexpiry.';
        }

        const toolReminder = `\n\nRounds left: ${roundsLeft}.${directive ? ' ' + directive : ''} REMINDER: tool calls MUST use <tool_call></tool_call> tags.`;
        llmMessages.push({ role: 'user', content: resultParts.join('\n\n') + toolReminder });
      } else {
        // Final answer — no tool call found by parser
        // Detect bare JSON or truncated tool calls and retry the round
        if (/\{"name"\s*:\s*"/.test(result.content)) {
          console.warn(`[tool-loop] response contains bare/truncated JSON tool call but parseToolCalls found nothing. Content (last 200 chars): ...${result.content.slice(-200)}`);
          llmMessages.push({ role: 'assistant', content: result.content });
          llmMessages.push({ role: 'user', content: 'Your tool call was not wrapped in <tool_call></tool_call> tags or was truncated. Please retry with valid format:\n<tool_call>\n{"name": "tool_name", "arguments": {...}}\n</tool_call>' });
          continue;
        }
        if (/<tool_call/i.test(result.content)) {
          console.warn(`[tool-loop] response contains <tool_call> tag but parseToolCalls found nothing. Content (first 500 chars):\n${result.content.slice(0, 500)}`);
          // Malformed tool call — ask LLM to retry with valid JSON instead of treating as final answer
          llmMessages.push({ role: 'assistant', content: result.content });
          llmMessages.push({ role: 'user', content: 'Your <tool_call> JSON was malformed and could not be parsed. Please retry the tool call with valid JSON: {"name": "tool_name", "arguments": {...}}' });
          continue;
        }
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
      }, true);
      if (forced.usage) lastUsage = forced.usage;

      // If the LLM STILL emitted a tool call, try one last execution
      const lastChanceCalls = parseToolCalls(forced.content);
      if (lastChanceCalls.length > 0) {
        console.warn(`[tool-loop] forced answer still contains tool call(s): ${lastChanceCalls.map(c => c.name).join(', ')}, executing last chance`);
        const context = {
          confirmFn: (command) => {
            res.write(`data: ${JSON.stringify({ confirm_command: { command } })}\n\n`);
            return requestConfirmation(conv.id, command);
          },
        };
        const results = await Promise.all(
          lastChanceCalls.map(tc => executeTool(tc.name, tc.arguments, context))
        );
        for (let i = 0; i < lastChanceCalls.length; i++) {
          toolUses.push({ name: lastChanceCalls[i].name, result: results[i] });
          res.write(`data: ${JSON.stringify({ tool_use: { name: lastChanceCalls[i].name, result: results[i] } })}\n\n`);
        }
        // One final round for the answer
        llmMessages.push({ role: 'assistant', content: forced.content });
        const resultParts = lastChanceCalls.map((tc, i) => `Tool "${tc.name}" result: ${results[i]}`);
        llmMessages.push({ role: 'user', content: resultParts.join('\n\n') + '\n\nNow provide your final answer. Do NOT call any tools.' });
        const final2 = await streamRound(llmMessages, { slotId, signal: abortController.signal }, true);
        finalContent = final2.content;
        if (final2.usage) lastUsage = final2.usage;
      } else {
        finalContent = forced.content;
      }
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
