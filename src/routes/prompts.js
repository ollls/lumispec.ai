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
          { role: 'system', content: 'Generate a concise 3-6 word title for the following prompt. Reply with ONLY the title, nothing else.' },
          { role: 'user', content: text.slice(0, 500) },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    let title = data.choices?.[0]?.message?.content?.trim();
    if (title) {
      // Strip Qwen3 think blocks if present
      title = title.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Strip quotes if wrapped
      title = title.replace(/^["']|["']$/g, '').trim();
      if (title) return title;
    }
    console.warn('generateTitle: no usable content in LLM response');
  } catch (err) {
    console.warn('generateTitle failed:', err.message);
  }
  return `Prompt_${Date.now()}`;
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
