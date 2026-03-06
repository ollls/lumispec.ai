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

function pingEngine(engine) {
  if (engine === 'tavily') {
    return fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.tavily.apiKey}`,
      },
      body: JSON.stringify({ query: 'ping', max_results: 1 }),
      signal: AbortSignal.timeout(5000),
    });
  }
  return fetch(`${config.keiro.baseUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: config.keiro.apiKey, query: 'ping' }),
    signal: AbortSignal.timeout(5000),
  });
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
        pingEngine('keiro').then(r => r.ok).catch(() => false),
        pingEngine('tavily').then(r => r.ok).catch(() => false),
      ]);
      ok = keiro || tavily; // green if at least one works
    } else {
      const resp = await pingEngine(engine);
      ok = resp.ok;
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

export default router;
