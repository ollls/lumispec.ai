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

const ENGINES = {
  keiro: { label: 'Keiro', configured: () => !!config.keiro.apiKey },
  tavily: { label: 'Tavily', configured: () => !!config.tavily.apiKey },
  both: { label: 'Both', configured: () => !!config.keiro.apiKey && !!config.tavily.apiKey },
};

// Zero-credit health check: send empty/missing query, check that key is accepted.
// Valid key → 422 (Tavily) or 400 (Keiro); invalid key → 401/403.
async function pingEngine(engine) {
  let resp;
  if (engine === 'tavily') {
    resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.tavily.apiKey}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000),
    });
  } else {
    resp = await fetch(`${config.keiro.baseUrl}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: config.keiro.apiKey }),
      signal: AbortSignal.timeout(5000),
    });
  }
  return resp.status !== 401 && resp.status !== 403;
}

router.get('/search', async (_req, res) => {
  const engine = config.search.engine;
  const label = ENGINES[engine]?.label || engine;
  const engines = Object.entries(ENGINES).map(([id, e]) => ({
    id, label: e.label, configured: e.configured(), active: id === engine,
  }));
  try {
    let ok;
    if (engine === 'both') {
      const [keiro, tavily] = await Promise.all([
        pingEngine('keiro').catch(() => false),
        pingEngine('tavily').catch(() => false),
      ]);
      ok = keiro || tavily;
    } else {
      ok = await pingEngine(engine);
    }
    res.json({ ok, engine: label, engines });
  } catch {
    res.json({ ok: false, engine: label, engines });
  }
});

router.post('/search', (req, res) => {
  const { engine } = req.body;
  if (!ENGINES[engine]) {
    return res.status(400).json({ error: `Unknown engine: ${engine}` });
  }
  if (!ENGINES[engine].configured()) {
    return res.status(400).json({ error: `${ENGINES[engine].label} requires API key(s) not configured` });
  }
  config.search.engine = engine;
  res.json({ engine, label: ENGINES[engine].label });
});

// ── LiteAPI health check ────────────────────────────
router.get('/liteapi', async (_req, res) => {
  if (!config.liteapi.apiKey) return res.json({ ok: false, configured: false });
  try {
    const resp = await fetch('https://api.liteapi.travel/v3.0/data/countries', {
      headers: { 'X-API-Key': config.liteapi.apiKey },
      signal: AbortSignal.timeout(5000),
    });
    res.json({ ok: resp.status !== 401 && resp.status !== 403, configured: true });
  } catch {
    res.json({ ok: false, configured: true });
  }
});

export default router;
