import { Router } from 'express';
import { listTools, setToolEnabled } from '../services/tools.js';

const router = Router();

router.get('/', (_req, res) => {
  res.json(listTools());
});

router.post('/:name/toggle', (req, res) => {
  const { name } = req.params;
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
  const ok = setToolEnabled(name, enabled);
  if (!ok) return res.status(404).json({ error: `Unknown tool: ${name}` });
  res.json({ name, enabled });
});

export default router;
