// Lumispec Browser Search — MV3 service worker.
//
// Two jobs:
//  1. Run a web search in a hidden (inactive) tab of the user's real browser and
//     parse the result page into [{ title, url, description }].
//  2. Keep a WebSocket open to the Lumispec server and answer its `search`
//     requests with those results. (Server side lands in part 2; the client is
//     complete and can be exercised from the popup's "Test search" without it.)

const DEFAULTS = {
  serverUrl: 'ws://localhost:3000/ws/browser',
  token: '',
  enabled: true,
};

const PAGE_LOAD_TIMEOUT_MS = 20000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ── Search engines ──────────────────────────────────
// Each parser runs INSIDE the result page via chrome.scripting.executeScript,
// so it must be self-contained: no closures over worker-scope variables.

const ENGINES = {
  duckduckgo: {
    label: 'DuckDuckGo',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: function parseDdg(limit) {
      const out = [];
      if (document.querySelector('.anomaly-modal, #challenge-form')) {
        return { error: 'DuckDuckGo showed a bot challenge page' };
      }
      for (const el of document.querySelectorAll('.result')) {
        const a = el.querySelector('.result__a');
        if (!a) continue;
        const href = a.getAttribute('href') || '';
        const m = href.match(/uddg=([^&]+)/);
        let url = m ? decodeURIComponent(m[1]) : href;
        if (url.startsWith('//')) url = 'https:' + url;
        if (!/^https?:\/\//.test(url)) continue;
        out.push({
          title: (a.textContent || '').trim(),
          url,
          description: (el.querySelector('.result__snippet')?.textContent || '').trim(),
        });
        if (out.length >= limit) break;
      }
      return { results: out };
    },
  },

  google: {
    label: 'Google',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&num=10`,
    parse: function parseGoogle(limit) {
      const path = location.pathname;
      if (path.startsWith('/sorry') || document.querySelector('form#captcha-form, #recaptcha')) {
        return { error: 'Google showed a CAPTCHA / unusual-traffic page' };
      }
      if (location.hostname.startsWith('consent.') || /before you continue/i.test(document.title)) {
        return { error: 'Google consent interstitial — open google.com once in this browser and accept it' };
      }
      const out = [];
      const seen = new Set();
      // Organic results: an <h3> inside an anchor. Ads and "People also ask" don't match.
      for (const h3 of document.querySelectorAll('#search a h3, #rso a h3')) {
        const a = h3.closest('a');
        if (!a) continue;
        let url = a.href || '';
        const m = url.match(/[?&]q=([^&]+)/);
        if (url.includes('/url?') && m) url = decodeURIComponent(m[1]);
        if (!/^https?:\/\//.test(url) || url.includes('google.com/')) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        // Snippet lives in a sibling block; selectors vary, try the stable ones first.
        const block = a.closest('[data-hveid], .g, [jscontroller]') || a.parentElement;
        const snippetEl = block?.querySelector('[data-sncf], .VwiC3b, div[style*="-webkit-line-clamp"]');
        out.push({
          title: (h3.textContent || '').trim(),
          url,
          description: (snippetEl?.textContent || '').trim(),
        });
        if (out.length >= limit) break;
      }
      if (!out.length) return { error: 'No organic results found on the Google page (layout change?)' };
      return { results: out };
    },
  },
};

// ── Hidden-tab search ───────────────────────────────

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Result page did not finish loading within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

let searchChain = Promise.resolve();

/** Serialized: one hidden tab at a time keeps us under engine rate limits. */
function runSearch(engine, query, limit = 8) {
  const run = () => doSearch(engine, query, limit);
  const p = searchChain.then(run, run);
  searchChain = p.catch(() => {});
  return p;
}

async function doSearch(engine, query, limit) {
  const def = ENGINES[engine];
  if (!def) throw new Error(`Unknown engine "${engine}" (have: ${Object.keys(ENGINES).join(', ')})`);
  if (!query || !query.trim()) throw new Error('Empty query');

  const started = Date.now();
  const tab = await chrome.tabs.create({ url: def.url(query), active: false });
  try {
    await waitForTabLoad(tab.id, PAGE_LOAD_TIMEOUT_MS);
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: def.parse,
      args: [limit],
    });
    if (!result) throw new Error('Parser returned nothing');
    if (result.error) throw new Error(result.error);
    return { engine: def.label, results: result.results, ms: Date.now() - started };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── WebSocket client ────────────────────────────────

let ws = null;
let wsState = 'disconnected'; // disconnected | connecting | connected
let lastError = '';
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

function setState(state, err = '') {
  wsState = state;
  lastError = err;
  chrome.action.setBadgeText({ text: state === 'connected' ? '' : '!' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: state === 'connected' ? '#16a34a' : '#b45309' }).catch(() => {});
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

async function connect() {
  clearTimeout(reconnectTimer);
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const { serverUrl, token, enabled } = await getSettings();
  if (!enabled) { setState('disconnected', 'Disabled in popup'); return; }

  let url;
  try {
    url = new URL(serverUrl);
    if (token) url.searchParams.set('token', token);
  } catch {
    setState('disconnected', `Invalid server URL: ${serverUrl}`);
    return;
  }

  setState('connecting');
  try {
    ws = new WebSocket(url.toString());
  } catch (e) {
    setState('disconnected', e.message);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    reconnectDelay = RECONNECT_MIN_MS;
    setState('connected');
    send({ type: 'hello', version: 1, engines: Object.keys(ENGINES), ua: navigator.userAgent });
  };
  ws.onmessage = (ev) => handleServerMessage(ev.data);
  ws.onerror = () => { lastError = 'Connection failed'; };
  ws.onclose = (ev) => {
    ws = null;
    setState('disconnected', lastError || `Closed (${ev.code})`);
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function disconnect() {
  clearTimeout(reconnectTimer);
  if (ws) { try { ws.close(1000, 'user'); } catch {} }
  ws = null;
  setState('disconnected', 'Disabled in popup');
}

async function handleServerMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', id: msg.id });
      return;
    case 'search': {
      try {
        const { results, engine, ms } = await runSearch(msg.engine, msg.query, msg.limit);
        send({ type: 'result', id: msg.id, engine, results, ms });
      } catch (e) {
        send({ type: 'error', id: msg.id, message: e.message });
      }
      return;
    }
    default:
      send({ type: 'error', id: msg.id, message: `Unknown message type "${msg.type}"` });
  }
}

// ── Popup API ───────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg.type) {
      case 'status': {
        const settings = await getSettings();
        reply({ state: wsState, lastError, settings, engines: Object.keys(ENGINES) });
        return;
      }
      case 'saveSettings':
        await chrome.storage.local.set(msg.settings);
        disconnect();
        if (msg.settings.enabled !== false) await connect();
        reply({ ok: true });
        return;
      case 'reconnect':
        if (ws) { try { ws.close(); } catch {} ws = null; }
        reconnectDelay = RECONNECT_MIN_MS;
        await connect();
        reply({ ok: true });
        return;
      case 'test':
        try {
          reply(await runSearch(msg.engine, msg.query, msg.limit || 8));
        } catch (e) {
          reply({ error: e.message });
        }
        return;
      default:
        reply({ error: `Unknown popup message "${msg.type}"` });
    }
  })();
  return true; // async reply
});

// ── Lifecycle ───────────────────────────────────────
// MV3 workers are suspended when idle. An open WebSocket keeps the worker alive
// on Chrome 116+; the alarm is the safety net that re-establishes the socket
// after the worker has been killed and restarted.

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connect();
});
connect();
