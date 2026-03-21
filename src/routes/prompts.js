import { Router } from 'express';
import { listPrompts, createPrompt, deletePrompt, updatePrompt, reorderPrompts } from '../services/prompts.js';
import { collectChatCompletion } from '../services/llm.js';

const router = Router();

async function generateTitle(text) {
  try {
    const { content: raw } = await collectChatCompletion([
      { role: 'system', content: 'Title the following text in 3-6 words.' },
      { role: 'user', content: text.slice(0, 200) },
    ], { signal: AbortSignal.timeout(30000), maxTokens: 200 });
    let title = raw?.trim();
    if (title) {
      // Strip Qwen3 think blocks if present
      title = title.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      // Detect system prompt leak (LLM echoed instructions instead of generating title)
      if (/title the following|reply with|nothing else/i.test(title)) {
        title = '';
      }
    }
    if (title) {
      title = title.replace(/^["']|["']$/g, '').trim();
      if (title.length > 60) title = title.slice(0, 60);
      if (title) return title;
    }
    console.warn('generateTitle: no usable content in LLM response. raw:', JSON.stringify(raw));
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
