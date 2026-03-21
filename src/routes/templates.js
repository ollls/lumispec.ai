import { Router } from 'express';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate, getTemplate, reorderTemplates } from '../services/templates.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(listTemplates());
});

router.get('/:id', (req, res) => {
  const template = getTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: 'not found' });
  res.json(template);
});

router.post('/', (req, res) => {
  const { name, type, html } = req.body;
  if (!name?.trim() || !html?.trim()) return res.status(400).json({ error: 'name and html required' });
  res.json(createTemplate(name.trim(), type || 'html', html));
});

router.patch('/:id', (req, res) => {
  const { name, type, html } = req.body;
  if (!name?.trim() && !html?.trim()) return res.status(400).json({ error: 'name or html required' });
  const updates = {};
  if (name?.trim()) updates.name = name.trim();
  if (type?.trim()) updates.type = type.trim();
  if (html?.trim()) updates.html = html.trim();
  const template = updateTemplate(req.params.id, updates);
  if (!template) return res.status(404).json({ error: 'not found' });
  res.json(template);
});

router.put('/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  res.json(reorderTemplates(ids));
});

router.delete('/:id', (req, res) => {
  deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
