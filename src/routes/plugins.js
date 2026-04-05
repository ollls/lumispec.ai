import { Router } from 'express';
import { getPluginStatuses, getPluginAuth, listPluginGroups, setPluginEnabled, updatePluginConfig } from '../services/tools.js';

const router = Router();

// List configurable plugin groups
router.get('/', async (_req, res) => {
  const groups = await listPluginGroups();
  res.json(groups);
});

// Toggle a plugin group on/off and/or update its config
router.post('/:group/toggle', async (req, res) => {
  const { enabled, mode, engines } = req.body;
  if (enabled === undefined && mode === undefined && engines === undefined) {
    return res.status(400).json({ error: 'At least one of enabled, mode, or engines required' });
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  const VALID_MODES = ['regular', 'stealth', 'browser'];
  if (mode !== undefined && !VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
  }
  const VALID_ENGINES = ['tavily', 'keiro', 'duckduckgo'];
  if (engines !== undefined) {
    if (!Array.isArray(engines) || !engines.every(e => VALID_ENGINES.includes(e))) {
      return res.status(400).json({ error: `engines must be array of: ${VALID_ENGINES.join(', ')}` });
    }
  }
  const updates = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (mode !== undefined) updates.mode = mode;
  if (engines !== undefined) updates.engines = engines;
  const result = await updatePluginConfig(req.params.group, updates);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Poll all plugin statuses in one call
router.get('/status', async (_req, res) => {
  const statuses = await getPluginStatuses();
  res.json(statuses);
});

// Generic auth: start
router.post('/:group/auth/start', async (req, res) => {
  const auth = getPluginAuth(req.params.group);
  if (!auth) return res.status(404).json({ error: 'No auth for this plugin' });
  try {
    const result = await auth.start();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic auth: complete
router.post('/:group/auth/complete', async (req, res) => {
  const auth = getPluginAuth(req.params.group);
  if (!auth) return res.status(404).json({ error: 'No auth for this plugin' });
  try {
    const result = await auth.complete(req.body.input);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic auth: disconnect
router.post('/:group/auth/disconnect', async (req, res) => {
  const auth = getPluginAuth(req.params.group);
  if (!auth) return res.status(404).json({ error: 'No auth for this plugin' });
  try {
    const result = await auth.disconnect();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
