import { Router } from 'express';
import { getPluginStatuses, getPluginAuth, listPluginGroups, runPluginCardAction, setPluginEnabled, updatePluginConfig } from '../services/tools.js';

const router = Router();

// List configurable plugin groups
router.get('/', async (_req, res) => {
  const groups = await listPluginGroups();
  res.json(groups);
});

// Toggle a plugin group on/off and/or update its config
router.post('/:group/toggle', async (req, res) => {
  const { enabled, mode, engines, config: fields } = req.body;
  if (enabled === undefined && mode === undefined && engines === undefined && fields === undefined) {
    return res.status(400).json({ error: 'At least one of enabled, mode, engines, or config required' });
  }
  // Generic per-plugin fields (declared by the plugin's `defaults`): only scalars, only keys the
  // plugin declares — updatePluginConfig drops the rest.
  if (fields !== undefined) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: 'config must be an object' });
    }
    for (const [k, v] of Object.entries(fields)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(k)) return res.status(400).json({ error: `Bad config key: ${k}` });
      if (!['string', 'number', 'boolean'].includes(typeof v)) return res.status(400).json({ error: `config.${k} must be a string, number or boolean` });
      if (typeof v === 'string' && v.length > 1024) return res.status(400).json({ error: `config.${k} too long` });
    }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }
  const VALID_MODES = ['auto', 'regular', 'stealth', 'browser'];
  if (mode !== undefined && !VALID_MODES.includes(mode)) {
    return res.status(400).json({ error: `mode must be one of: ${VALID_MODES.join(', ')}` });
  }
  // Engine ids are plugin-specific (web: tavily/keiro/duckduckgo, browser: duckduckgo/google);
  // each plugin ignores ids it does not know, so only the shape is validated here.
  if (engines !== undefined) {
    if (!Array.isArray(engines) || !engines.every(e => typeof e === 'string' && /^[a-z0-9_-]{1,32}$/.test(e))) {
      return res.status(400).json({ error: 'engines must be an array of engine ids' });
    }
  }
  const updates = {};
  if (enabled !== undefined) updates.enabled = enabled;
  if (mode !== undefined) updates.mode = mode;
  if (engines !== undefined) updates.engines = engines;
  if (fields !== undefined) updates.config = fields;
  const result = await updatePluginConfig(req.params.group, updates);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Poll all plugin statuses in one call
router.get('/status', async (_req, res) => {
  const statuses = await getPluginStatuses();
  res.json(statuses);
});

// Card helper button (e.g. Browser Search → open chrome://extensions). Action ids are
// plugin-defined constants; nothing from the request body reaches the plugin.
router.post('/:group/action/:id', async (req, res) => {
  if (!/^[a-z0-9-]{1,32}$/.test(req.params.id)) return res.status(400).json({ error: 'Bad action id' });
  try {
    const result = await runPluginCardAction(req.params.group, req.params.id);
    if (result?.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
