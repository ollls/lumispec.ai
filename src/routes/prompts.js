import { Router } from 'express';
import { listPrompts, createPrompt, deletePrompt, updatePrompt, reorderPrompts } from '../services/prompts.js';
import config from '../config.js';

const router = Router();

async function generateTitle(text) {
  try {
    const res = await fetch(`${config.llama.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Title the following text in 3-6 words.' },
          { role: 'user', content: text.slice(0, 200) },
        ],
        max_tokens: 8000,
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    let title = msg?.content?.trim();
    if (title) {
      // Strip Qwen3 think blocks if present
      title = title.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Detect system prompt leak (LLM echoed instructions instead of generating title)
      if (/title the following|reply with|nothing else/i.test(title)) {
        title = '';
      }
    }
    // Qwen3 separates reasoning into reasoning_content, leaving content empty
    if (!title && msg?.reasoning_content) {
      // Extract last quoted string from reasoning as best title candidate
      const quoted = msg.reasoning_content.match(/"([^"]{3,80})"/g);
      if (quoted?.length) {
        title = quoted[quoted.length - 1].replace(/"/g, '').trim();
      }
    }
    if (title) {
      title = title.replace(/^["']|["']$/g, '').trim();
      if (title.length > 60) title = title.slice(0, 60);
      if (title) return title;
    }
    console.warn('generateTitle: no usable content in LLM response. msg:', JSON.stringify(msg));
  } catch (err) {
    console.warn('generateTitle failed:', err.message, err.cause || '');
  }
  // Fallback: first meaningful sentence fragment, truncated
  const fallback = text.replace(/^you are [^.]*\.\s*/i, '').trim();
  const short = fallback.slice(0, 50).replace(/\s+\S*$/, '');
  return short || text.slice(0, 40);
}

router.get('/', (_req, res) => {
  res.json(listPrompts());
});

router.post('/', async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  const title = await generateTitle(text.trim());
  res.json(createPrompt(text.trim(), title));
});

router.patch('/:id', (req, res) => {
  const { text, title } = req.body;
  if (!text?.trim() && !title?.trim()) return res.status(400).json({ error: 'text or title required' });
  const updates = {};
  if (text?.trim()) updates.text = text.trim();
  if (title?.trim()) updates.title = title.trim();
  const prompt = updatePrompt(req.params.id, updates);
  if (!prompt) return res.status(404).json({ error: 'not found' });
  res.json(prompt);
});

router.put('/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  res.json(reorderPrompts(ids));
});

router.delete('/:id', (req, res) => {
  deletePrompt(req.params.id);
  res.json({ ok: true });
});

export default router;
