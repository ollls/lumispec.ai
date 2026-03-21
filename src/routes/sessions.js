import { Router } from 'express';
import { listSessions, upsertSession, deleteSession } from '../services/sessions.js';
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
      title = title.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (/title the following|reply with|nothing else/i.test(title)) title = '';
    }
    if (title) {
      title = title.replace(/^["']|["']$/g, '').trim();
      if (title.length > 60) title = title.slice(0, 60);
      if (title) return title;
    }
    console.warn('generateTitle (session): no usable content. raw:', JSON.stringify(raw));
  } catch (err) {
    console.warn('generateTitle (session) failed:', err.message, err.cause || '');
  }
  const fallback = text.replace(/^you are [^.]*\.\s*/i, '').trim();
  const short = fallback.slice(0, 50).replace(/\s+\S*$/, '');
  return short || text.slice(0, 40);
}

router.get('/', (_req, res) => {
  res.json(listSessions());
});

router.post('/', async (req, res) => {
  const { text, color } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });
  if (!color?.trim()) return res.status(400).json({ error: 'color required' });
  const title = await generateTitle(text.trim());
  res.json(upsertSession(color.trim(), text.trim(), title));
});

router.delete('/:id', (req, res) => {
  deleteSession(req.params.id);
  res.json({ ok: true });
});

export default router;
