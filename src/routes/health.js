import { Router } from 'express';
import slotsService from '../services/slots.js';
import config from '../config.js';

const router = Router();

router.get('/', async (_req, res) => {
  const health = await slotsService.checkHealth();
  if (health.status === 'error') {
    return res.status(502).json(health);
  }
  res.json(health);
});

router.get('/internet', async (_req, res) => {
  try {
    const resp = await fetch('https://1.1.1.1/cdn-cgi/trace', {
      signal: AbortSignal.timeout(3000),
    });
    res.json({ ok: resp.ok });
  } catch {
    res.json({ ok: false });
  }
});


// ── LLM backend switcher ────────────────────────────

const LLM_BACKENDS = {
  llama:  { label: 'llama.cpp', configured: () => !!config.llama.baseUrl },
  claude: { label: 'Claude',   configured: () => !!config.claude.apiKey },
};

async function pingBackend(id) {
  if (id === 'claude') {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.claude.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: config.claude.model, max_tokens: 1, messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    return resp.status !== 401 && resp.status !== 403;
  }
  // llama
  const resp = await fetch(`${config.llama.baseUrl}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  return resp.ok;
}

router.get('/llm', async (_req, res) => {
  const id = config.llm.backend;
  const label = LLM_BACKENDS[id]?.label || id;
  const backends = Object.entries(LLM_BACKENDS).map(([bid, b]) => ({
    id: bid, label: b.label, configured: b.configured(), active: bid === id,
  }));
  try {
    const ok = await pingBackend(id);
    res.json({ ok, backend: label, backends });
  } catch {
    res.json({ ok: false, backend: label, backends });
  }
});

router.post('/llm', (req, res) => {
  const { backend } = req.body;
  if (!LLM_BACKENDS[backend]) {
    return res.status(400).json({ error: `Unknown backend: ${backend}` });
  }
  if (!LLM_BACKENDS[backend].configured()) {
    return res.status(400).json({ error: `${LLM_BACKENDS[backend].label} requires configuration` });
  }
  config.llm.backend = backend;
  res.json({ backend, label: LLM_BACKENDS[backend].label });
});

export default router;
