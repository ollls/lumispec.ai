import { Router } from 'express';
import { listTemplates, createTemplate, deleteTemplate, getTemplate } from '../services/templates.js';

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

router.delete('/:id', (req, res) => {
  deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
