import { Router } from 'express';
import conversations from '../services/conversations.js';
import slots from '../services/slots.js';
import { streamChatCompletion, parseSSEChunks } from '../services/llm.js';
import { getSystemPrompt, parseToolCalls, executeTool, requestConfirmation, cancelConfirmation } from '../services/tools.js';

const router = Router();

const MAX_TOOL_ROUNDS = 20;
const MAX_SAME_TOOL_REPEATS = 3;
const MAX_PARALLEL_TOOLS = 4;
const MAX_PREV_RESULT_CHARS = 32000;

// Review pause mechanism — pending promises per conversation
const pendingReviews = new Map(); // convId → { resolve }

function requestReview(convId) {
  return new Promise((resolve) => {
    pendingReviews.set(convId, { resolve });
  });
}

function resolveReview(convId, action, comment) {
  const pending = pendingReviews.get(convId);
  if (!pending) return false;
  pendingReviews.delete(convId);
  pending.resolve({ action, comment: comment || '' });
  return true;
}

function cancelReview(convId) {
  const pending = pendingReviews.get(convId);
  if (pending) {
    pendingReviews.delete(convId);
    pending.resolve({ action: 'continue', comment: '' }); // unblock on abort
  }
}

// Review response endpoint
router.post('/:id/task-review', (req, res) => {
  const { action, comment } = req.body;
  if (!action || !['continue', 'retry'].includes(action)) {
    return res.status(400).json({ error: 'action must be continue or retry' });
  }
  const resolved = resolveReview(req.params.id, action, comment);
  if (!resolved) return res.status(404).json({ error: 'No pending review' });
  res.json({ ok: true });
});

router.post('/:id/tasks', async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const { tasks, applets, autorun, review, precision } = req.body;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'tasks array required' });
  }

  // Normalize tasks: string → {text}, ensure subtasks array
  const normalizedTasks = tasks.map(t => {
    if (typeof t === 'string') return { text: t, subtasks: [] };
    return { text: t.text, subtasks: t.subtasks || [] };
  });

  // Store user message as the task list text
  const taskListText = normalizedTasks.map(t => {
    let line = `- ${t.text}`;
    if (t.subtasks.length > 0) {
      line += '\n' + t.subtasks.map(s => `  - ${s}`).join('\n');
    }
    return line;
  }).join('\n');
  conversations.addMessage(conv.id, 'user', taskListText);

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
    cancelReview(conv.id);
  });

  const systemPrompt = getSystemPrompt({ applets: !!applets, precision: !!precision });
  const taskRunResults = [];
  let prevResult = null;
  let totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const savedFiles = []; // track files saved across the pipeline

  // Count total steps (tasks + subtasks) for progress
  let totalSteps = 0;
  for (const t of normalizedTasks) {
    totalSteps += t.subtasks.length > 0 ? t.subtasks.length : 1;
  }

  try {
    for (let ti = 0; ti < normalizedTasks.length; ti++) {
      if (abortController.signal.aborted) break;

      const task = normalizedTasks[ti];
      const hasSubtasks = task.subtasks.length > 0;
      const prevResultBeforeTask = prevResult; // save for retry

      if (hasSubtasks) {
        // Parent task with subtasks — parent is a label, execute subtasks sequentially
        res.write(`data: ${JSON.stringify({ task_start: { index: ti, total: normalizedTasks.length, text: task.text, subtasks: task.subtasks } })}\n\n`);

        const subtaskResults = [];

        for (let si = 0; si < task.subtasks.length; si++) {
          if (abortController.signal.aborted) break;

          res.write(`data: ${JSON.stringify({ subtask_start: { taskIndex: ti, subtaskIndex: si, total: task.subtasks.length, text: task.subtasks[si] } })}\n\n`);

          const result = await processOneStep(task.subtasks[si], prevResult, {
            systemPrompt, slotId, abortController, autorun: !!autorun, conv, res,
            stepLabel: `Subtask ${si + 1}/${task.subtasks.length} of Task ${ti + 1}`,
            allTasks: normalizedTasks, savedFiles,
          });

          if (result.error) {
            res.write(`data: ${JSON.stringify({ task_error: { index: ti, subtaskIndex: si, error: result.error } })}\n\n`);
            // Store partial results and stop
            taskRunResults.push({ text: task.text, subtasks: subtaskResults, error: result.error });
            storeAndFinish();
            return;
          }

          subtaskResults.push({ text: task.subtasks[si], result: result.content, toolUses: result.toolUses });
          addUsage(totalUsage, result.usage);
          if (result.savedFiles) savedFiles.push(...result.savedFiles);

          res.write(`data: ${JSON.stringify({ subtask_complete: { taskIndex: ti, subtaskIndex: si } })}\n\n`);
        }

        taskRunResults.push({ text: task.text, subtasks: subtaskResults });
        // Merge subtask results as prevResult for next task
        prevResult = subtaskResults.map(s => `## ${s.text}\n\n${s.result}`).join('\n\n---\n\n');
        res.write(`data: ${JSON.stringify({ task_complete: { index: ti } })}\n\n`);

        // Review pause (if enabled and not last task)
        if (review && ti < normalizedTasks.length - 1) {
          res.write(`data: ${JSON.stringify({ task_review: { index: ti } })}\n\n`);
          const reviewResult = await requestReview(conv.id);
          if (reviewResult.action === 'retry') {
            // Re-run all subtasks for this group
            taskRunResults.pop();
            subtaskResults.length = 0;
            prevResult = prevResultBeforeTask;
            ti--;
            continue;
          }
          if (reviewResult.comment) {
            prevResult += `\n\n---\n\nUser guidance: ${reviewResult.comment}`;
          }
        }

      } else {
        // Simple task — no subtasks
        res.write(`data: ${JSON.stringify({ task_start: { index: ti, total: normalizedTasks.length, text: task.text } })}\n\n`);

        const result = await processOneStep(task.text, prevResult, {
          systemPrompt, slotId, abortController, autorun: !!autorun, conv, res,
          stepLabel: `Task ${ti + 1}/${normalizedTasks.length}`,
          allTasks: normalizedTasks, savedFiles,
        });

        if (result.error) {
          res.write(`data: ${JSON.stringify({ task_error: { index: ti, error: result.error } })}\n\n`);
          taskRunResults.push({ text: task.text, error: result.error });
          storeAndFinish();
          return;
        }

        taskRunResults.push({ text: task.text, result: result.content, toolUses: result.toolUses });
        addUsage(totalUsage, result.usage);
        if (result.savedFiles) savedFiles.push(...result.savedFiles);
        prevResult = result.content;

        res.write(`data: ${JSON.stringify({ task_complete: { index: ti } })}\n\n`);

        // Review pause (if enabled and not last task)
        if (review && ti < normalizedTasks.length - 1) {
          res.write(`data: ${JSON.stringify({ task_review: { index: ti } })}\n\n`);
          const reviewResult = await requestReview(conv.id);
          if (reviewResult.action === 'retry') {
            // Re-run this task
            taskRunResults.pop();
            prevResult = prevResultBeforeTask;
            ti--;
            continue;
          }
          if (reviewResult.comment) {
            prevResult += `\n\n---\n\nUser guidance: ${reviewResult.comment}`;
          }
        }
      }
    }

    if (totalUsage.total_tokens > 0) {
      conversations.setTokenCount(conv.id, totalUsage.total_tokens);
      res.write(`data: ${JSON.stringify({ usage: totalUsage })}\n\n`);
    }

  } catch (err) {
    if (err.name !== 'AbortError') {
      res.write(`data: ${JSON.stringify({ error: err.message || 'Task processing failed' })}\n\n`);
    }
  }

  storeAndFinish();

  function storeAndFinish() {
    // Build combined text for backward-compatible rendering
    const textParts = [];
    for (let i = 0; i < taskRunResults.length; i++) {
      const tr = taskRunResults[i];
      if (tr.subtasks) {
        textParts.push(`### Task ${i + 1}/${normalizedTasks.length}: ${tr.text}`);
        for (const st of tr.subtasks) {
          textParts.push(`#### ${st.text}\n\n${st.result}`);
        }
        if (tr.error) textParts.push(`\n**Error:** ${tr.error}`);
      } else {
        textParts.push(`### Task ${i + 1}/${normalizedTasks.length}: ${tr.text}\n\n${tr.result || ''}`);
        if (tr.error) textParts.push(`\n**Error:** ${tr.error}`);
      }
    }

    const stored = {
      text: textParts.join('\n\n---\n\n'),
      taskRun: taskRunResults,
    };
    conversations.updateMessageContent(conv.id, msgIndex, stored);

    res.write('data: [DONE]\n\n');
    res.end();

    // Auto-title
    const updated = conversations.get(conv.id);
    if (updated && updated.title === 'New conversation') {
      const title = `Tasks: ${normalizedTasks.map(t => t.text).join(', ')}`.slice(0, 120);
      conversations.updateTitle(conv.id, title);
    }
  }
});

// Process one task/subtask step with full tool loop
async function processOneStep(taskText, prevResult, { systemPrompt, slotId, abortController, autorun, conv, res, stepLabel, allTasks, savedFiles = [] }) {
  console.log(`[task-processor] ${stepLabel}: "${taskText.slice(0, 80)}" | prevResult: ${prevResult ? prevResult.length + ' chars' : 'none'} | savedFiles: ${savedFiles.length}`);

  // Build pipeline-aware system prompt — hide future tasks to prevent working ahead
  const pipelinePreamble = `\n\n## Task Pipeline
You are executing ${stepLabel} in a sequential pipeline of ${allTasks.length} total tasks. Another step will handle the rest — you do NOT know what comes next.

CRITICAL RULES:
- Complete ONLY the current task described below. STOP when it is done. Do NOT anticipate or work on anything beyond what is explicitly asked.
- If previous step output is provided, it contains ALL data gathered so far. USE it directly — do NOT re-fetch or re-search for information already present in the output.
- Produce a thorough, complete, data-rich output. Your output is the ONLY context the next step will receive — include all relevant details, numbers, names, and raw data.
- If your task is to transform, filter, or visualize data — work with the data provided, do not gather new data unless the provided data is clearly insufficient for the task.
- When tools save data to files (CSV, JSON, etc.), ALWAYS include the exact filename in your output (e.g. "Data saved to optionchains_12345.csv"). The next step can read these files via run_python. Prefer referencing saved files over embedding large data in your response.
- For financial/tabular data: save results to file first, then summarize key findings. Include both the filename AND a brief summary so the next step has the file path for detailed processing and the summary for context.`;

  const llmMessages = [{ role: 'system', content: systemPrompt + pipelinePreamble }];

  // Isolated context: previous result as user context + current task
  const filesSection = savedFiles.length > 0
    ? `\n\n## Available Data Files\nThese files were saved by previous steps. Use run_python with pd.read_csv() to access them:\n${savedFiles.map(f => `- **${f.filename}** (from ${f.tool})`).join('\n')}\n`
    : '';

  if (prevResult) {
    const truncated = prevResult.length > MAX_PREV_RESULT_CHARS
      ? prevResult.slice(0, MAX_PREV_RESULT_CHARS) + `\n\n[...truncated from ${prevResult.length} chars]`
      : prevResult;
    llmMessages.push({ role: 'user', content: `## Previous Step Output\n\n${truncated}${filesSection}\n\n---\n\n## Current Task\n\n${taskText}` });
  } else {
    llmMessages.push({ role: 'user', content: filesSection ? `${filesSection}\n\n---\n\n## Current Task\n\n${taskText}` : taskText });
  }

  let accumulatedReasoning = '';
  const toolUses = [];
  const toolCallSigCounts = {};
  const toolCallSigs = new Set();

  // streamRound — same pattern as conversations.js
  async function streamRound(messages, isToolRound = false) {
    const { response, backend } = await streamChatCompletion(messages, {
      slotId,
      signal: abortController.signal,
    });
    let content = '';
    let usage = null;
    let suppressToolContent = false;
    let toolContentBuffer = '';
    let toolContentFlushed = false;

    for await (const chunk of parseSSEChunks(response, backend)) {
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.reasoning_content) {
        accumulatedReasoning += delta.reasoning_content;
        res.write(`data: ${JSON.stringify({ reasoning: delta.reasoning_content })}\n\n`);
      }
      if (delta?.content) {
        content += delta.content;
        if (isToolRound && !suppressToolContent) {
          if (/\{"name"\s*:/.test(content) || /<tool_call>/i.test(content)) {
            suppressToolContent = true;
            toolContentBuffer = '';
          } else if (!toolContentFlushed) {
            toolContentBuffer += delta.content;
            const trimmed = toolContentBuffer.trimStart();
            if (trimmed.length > 30 && !/^\s*[{<]/.test(trimmed)) {
              res.write(`data: ${JSON.stringify({ tool_content: toolContentBuffer })}\n\n`);
              toolContentFlushed = true;
              toolContentBuffer = '';
            }
          } else {
            res.write(`data: ${JSON.stringify({ tool_content: delta.content })}\n\n`);
          }
        }
      }
      const timings = chunk.timings || chunk.usage;
      if (timings) {
        const prompt = timings.prompt_n ?? timings.prompt_tokens ?? 0;
        const predicted = timings.predicted_n ?? timings.completion_tokens ?? 0;
        usage = { prompt_tokens: prompt, completion_tokens: predicted, total_tokens: prompt + predicted };
      }
    }

    if (isToolRound && !suppressToolContent && toolContentBuffer) {
      res.write(`data: ${JSON.stringify({ tool_content: toolContentBuffer })}\n\n`);
    }

    return { content, usage };
  }

  let finalContent = '';
  let lastUsage = null;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const result = await streamRound(llmMessages, true);
      if (result.usage) lastUsage = result.usage;

      const toolCallsFound = parseToolCalls(result.content);

      if (toolCallsFound.length > 0) {
        // Track repeat tool calls
        for (const tc of toolCallsFound) {
          const sig = tc.name + ':' + JSON.stringify(tc.arguments || {});
          if (toolCallSigs.has(sig)) {
            toolCallSigCounts[sig] = (toolCallSigCounts[sig] || 1) + 1;
          } else {
            toolCallSigs.add(sig);
          }
        }

        const overLimit = toolCallsFound.filter(tc => {
          const sig = tc.name + ':' + JSON.stringify(tc.arguments || {});
          return (toolCallSigCounts[sig] || 0) > MAX_SAME_TOOL_REPEATS;
        });

        if (overLimit.length > 0) {
          const overName = overLimit[0].name;
          const overSig = overName + ':' + JSON.stringify(overLimit[0].arguments || {});
          const overCount = toolCallSigCounts[overSig];

          // Execute remaining allowed tools
          const allowedCalls = toolCallsFound.filter(tc => {
            const sig = tc.name + ':' + JSON.stringify(tc.arguments || {});
            return (toolCallSigCounts[sig] || 0) <= MAX_SAME_TOOL_REPEATS;
          });
          if (allowedCalls.length > 0) {
            const context = buildToolContext(autorun, conv, res);
            const results = await Promise.all(allowedCalls.map(tc => executeTool(tc.name, tc.arguments, context)));
            for (let i = 0; i < allowedCalls.length; i++) {
              toolUses.push({ name: allowedCalls[i].name, result: results[i] });
              res.write(`data: ${JSON.stringify({ tool_use: { name: allowedCalls[i].name, result: results[i] } })}\n\n`);
            }
          }

          llmMessages.push({ role: 'assistant', content: result.content });
          llmMessages.push({ role: 'user', content: `Tool "${overName}" called ${overCount} times with identical arguments and is now DISABLED. Provide your final answer NOW using the results you have. Do NOT call any tools.` });
          const forceResult = await streamRound(llmMessages, true);
          if (forceResult.usage) lastUsage = forceResult.usage;
          finalContent = forceResult.content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
          break;
        }

        // Cap parallel tool calls
        if (toolCallsFound.length > MAX_PARALLEL_TOOLS) {
          toolCallsFound.length = MAX_PARALLEL_TOOLS;
        }

        // Execute tools
        const context = buildToolContext(autorun, conv, res);
        const results = await Promise.all(toolCallsFound.map(tc => executeTool(tc.name, tc.arguments, context)));
        const resultParts = [];
        for (let i = 0; i < toolCallsFound.length; i++) {
          toolUses.push({ name: toolCallsFound[i].name, result: results[i] });
          res.write(`data: ${JSON.stringify({ tool_use: { name: toolCallsFound[i].name, result: results[i] } })}\n\n`);
          resultParts.push(buildToolResultText(toolCallsFound[i].name, results[i]));
        }

        llmMessages.push({ role: 'assistant', content: result.content });
        const roundsLeft = MAX_TOOL_ROUNDS - round - 1;
        llmMessages.push({ role: 'user', content: resultParts.join('\n\n') + `\n\nRounds left: ${roundsLeft}. REMINDER: tool calls MUST use <tool_call></tool_call> tags.` });

      } else {
        // No tool calls — check for malformed calls
        const hasApplet = /<applet[\s>]/i.test(result.content);
        if (!hasApplet && /\{"name"\s*:\s*"/.test(result.content)) {
          llmMessages.push({ role: 'assistant', content: result.content });
          llmMessages.push({ role: 'user', content: 'Your tool call was not wrapped in <tool_call></tool_call> tags or was truncated. Please retry with valid format:\n<tool_call>\n{"name": "tool_name", "arguments": {...}}\n</tool_call>' });
          continue;
        }
        if (!hasApplet && /<tool_call/i.test(result.content)) {
          llmMessages.push({ role: 'assistant', content: result.content });
          llmMessages.push({ role: 'user', content: 'Your <tool_call> JSON was malformed and could not be parsed. Please retry with valid JSON.' });
          continue;
        }
        finalContent = result.content;
        break;
      }
    }

    // Force answer if loop exhausted
    if (!finalContent) {
      llmMessages.push({ role: 'user', content: 'You have used all available tool rounds. Provide your best answer now. Do NOT call any tools.' });
      const forced = await streamRound(llmMessages, true);
      if (forced.usage) lastUsage = forced.usage;
      finalContent = forced.content;
    }

    // Clean up final content
    if (finalContent) {
      finalContent = finalContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      finalContent = finalContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
      if (/^\s*\{"name"\s*:/.test(finalContent) && finalContent.replace(/\s/g, '').endsWith('}}')) {
        finalContent = '';
      }
    }

    // Stream final content for this step
    console.log(`[task-processor] step done: "${taskText.slice(0, 40)}" → ${finalContent ? finalContent.length + ' chars' : 'empty'}`);
    if (finalContent) {
      res.write(`data: ${JSON.stringify({ content: finalContent })}\n\n`);
    }

    // Extract saved filenames from tool results
    const stepFiles = [];
    for (const tu of toolUses) {
      try {
        const parsed = JSON.parse(tu.result);
        if (parsed._autoSaved && parsed.savedFile?.filename) {
          stepFiles.push({ filename: parsed.savedFile.filename, tool: tu.name, note: parsed._note || '' });
        }
      } catch {}
    }

    return { content: finalContent || '', usage: lastUsage, toolUses, savedFiles: stepFiles };

  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { error: err.message || 'LLM request failed', content: '', usage: lastUsage, toolUses, savedFiles: [] };
  }
}

function buildToolContext(autorun, conv, res) {
  return {
    autorun,
    confirmFn: (command) => {
      res.write(`data: ${JSON.stringify({ confirm_command: { command } })}\n\n`);
      return requestConfirmation(conv.id, command);
    },
  };
}

function buildToolResultText(toolName, result) {
  try {
    const parsed = JSON.parse(result);
    if (parsed._autoSaved && parsed.savedFile) {
      const { _markdown, ...summary } = parsed;
      return `Tool "${toolName}" result: ${JSON.stringify(summary)}`;
    }
    if (parsed._markdown) {
      const { _markdown, ...summary } = parsed;
      const mdLines = _markdown.split('\n');
      let truncatedMd = _markdown;
      const dataRowStart = mdLines.findIndex(l => l.startsWith('|')) + 2;
      if (dataRowStart > 1) {
        const dataRows = mdLines.slice(dataRowStart).filter(l => l.startsWith('|'));
        if (dataRows.length > 30) {
          truncatedMd = mdLines.slice(0, dataRowStart + 30).join('\n') + `\n... (${dataRows.length - 30} more rows)`;
        }
      }
      return truncatedMd + (Object.keys(summary).length ? '\n\n' + JSON.stringify(summary) : '');
    }
    if (parsed._images || parsed._rateMap || parsed._diff) {
      const { _images, _rateMap, _diff, ...rest } = parsed;
      if (_images) rest.imageCount = Array.isArray(_images) ? _images.length : 0;
      if (_rateMap) rest.rateCount = Object.keys(_rateMap).length;
      return `Tool "${toolName}" result: ${JSON.stringify(rest)}`;
    }
    if (parsed.error) {
      return `⚠ TOOL ERROR — "${toolName}" FAILED: ${parsed.error}. You MUST acknowledge this error to the user. Do NOT report success.`;
    }
    if (parsed.denied) {
      return `⚠ DENIED — "${toolName}": ${parsed.message}. The operation was NOT performed.`;
    }
  } catch {}
  return `Tool "${toolName}" result: ${result}`;
}

function addUsage(total, usage) {
  if (!usage) return;
  total.prompt_tokens += usage.prompt_tokens || 0;
  total.completion_tokens += usage.completion_tokens || 0;
  total.total_tokens += usage.total_tokens || 0;
}

export default router;
