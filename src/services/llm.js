import config from '../config.js';

export async function streamChatCompletion(messages, { slotId, signal } = {}) {
  const body = {
    messages,
    stream: true,
  };
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

  return res;
}

export async function collectChatCompletion(messages, { slotId, signal } = {}) {
  const body = { messages, stream: false };
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

export async function* parseSSEChunks(response) {
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
