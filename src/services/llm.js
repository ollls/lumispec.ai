import config from '../config.js';

// ── Helpers ──────────────────────────────────────────────

function extractSystemMessage(messages) {
  if (messages.length && messages[0].role === 'system') {
    return { system: messages[0].content, messages: messages.slice(1) };
  }
  return { system: '', messages };
}

function mergeConsecutiveRoles(messages) {
  const merged = [];
  for (const msg of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge content — handle both string and array content
      const prevText = typeof prev.content === 'string' ? prev.content : prev.content.map(c => c.text || '').join('');
      const curText = typeof msg.content === 'string' ? msg.content : msg.content.map(c => c.text || '').join('');
      prev.content = prevText + '\n\n' + curText;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

function convertVisionForClaude(messages) {
  return messages.map(msg => {
    if (!Array.isArray(msg.content)) return msg;
    const converted = msg.content.map(part => {
      if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:')) {
        const match = part.image_url.url.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
        }
      }
      return part;
    });
    return { ...msg, content: converted };
  });
}

// ── Streaming ────────────────────────────────────────────

export async function streamChatCompletion(messages, { slotId, signal } = {}) {
  if (config.llm.backend === 'claude') {
    return streamClaudeCompletion(messages, { signal });
  }
  return streamLlamaCompletion(messages, { slotId, signal });
}

async function streamLlamaCompletion(messages, { slotId, signal } = {}) {
  const body = { messages, stream: true };
  if (slotId != null) body.id_slot = slotId;

  const res = await fetch(`${config.llama.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`llama-server ${res.status}: ${text}`);
  }

  return { response: res, backend: 'llama' };
}

async function streamClaudeCompletion(messages, { signal } = {}) {
  const { system, messages: msgs } = extractSystemMessage(messages);
  const prepared = convertVisionForClaude(mergeConsecutiveRoles(msgs));

  const body = {
    model: config.claude.model,
    max_tokens: config.claude.maxTokens,
    stream: true,
    messages: prepared,
  };
  if (system) body.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.claude.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${text}`);
  }

  return { response: res, backend: 'claude' };
}

// ── Non-streaming ────────────────────────────────────────

export async function collectChatCompletion(messages, { slotId, signal, maxTokens } = {}) {
  if (config.llm.backend === 'claude') {
    return collectClaudeCompletion(messages, { signal, maxTokens });
  }
  return collectLlamaCompletion(messages, { slotId, signal, maxTokens });
}

async function collectLlamaCompletion(messages, { slotId, signal, maxTokens } = {}) {
  const body = {
    messages,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  if (maxTokens) body.max_tokens = maxTokens;
  if (slotId != null) body.id_slot = slotId;

  const res = await fetch(`${config.llama.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`llama-server ${res.status}: ${text}`);
  }

  const json = await res.json();
  const choice = json.choices?.[0];
  const content = choice?.message?.content || '';
  const timings = json.timings || json.usage;
  let usage = null;
  if (timings) {
    const prompt = timings.prompt_n ?? timings.prompt_tokens ?? 0;
    const predicted = timings.predicted_n ?? timings.completion_tokens ?? 0;
    usage = { prompt_tokens: prompt, completion_tokens: predicted, total_tokens: prompt + predicted };
  }
  return { content, usage };
}

async function collectClaudeCompletion(messages, { signal, maxTokens } = {}) {
  const { system, messages: msgs } = extractSystemMessage(messages);
  const prepared = convertVisionForClaude(mergeConsecutiveRoles(msgs));

  const body = {
    model: config.claude.model,
    max_tokens: maxTokens || config.claude.maxTokens,
    stream: false,
    messages: prepared,
  };
  if (system) body.system = system;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.claude.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${text}`);
  }

  const json = await res.json();
  const textBlock = json.content?.find(b => b.type === 'text');
  const content = textBlock?.text || '';
  const u = json.usage;
  const usage = u ? {
    prompt_tokens: u.input_tokens || 0,
    completion_tokens: u.output_tokens || 0,
    total_tokens: (u.input_tokens || 0) + (u.output_tokens || 0),
  } : null;
  return { content, usage };
}

// ── SSE Parsing ──────────────────────────────────────────

export async function* parseSSEChunks(response, backend) {
  if (backend === 'claude') {
    yield* parseClaudeSSEChunks(response);
  } else {
    yield* parseLlamaSSEChunks(response);
  }
}

async function* parseLlamaSSEChunks(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') return;
          try {
            yield JSON.parse(payload);
          } catch { /* skip malformed */ }
        }
      }
    }

    // flush remaining buffer
    if (buffer.trim()) {
      for (const line of buffer.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch { /* skip malformed */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseClaudeSSEChunks(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let inputTokens = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        let eventType = '';
        let data = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7).trim();
          else if (line.startsWith('data: ')) data = line.slice(6).trim();
        }
        if (!data) continue;

        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }

        if (eventType === 'message_start') {
          inputTokens = parsed.message?.usage?.input_tokens || 0;
        } else if (eventType === 'content_block_delta') {
          const delta = parsed.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            yield { choices: [{ delta: { content: delta.text } }] };
          }
        } else if (eventType === 'message_delta') {
          const outputTokens = parsed.usage?.output_tokens || 0;
          yield {
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            },
          };
        } else if (eventType === 'message_stop') {
          return;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
