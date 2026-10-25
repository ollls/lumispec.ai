// Browser Search — routes web_search / web_fetch through the Lumispec Browser Search
// Chrome extension (extension/), which loads a URL in a hidden tab of the user's own browser
// and returns the rendered HTML over the WebSocket bridge (services/browserBridge.js).
//
// ALL search-engine knowledge lives here, server-side: which URL to open for a query, how to
// parse the result page (linkedom), how to recognise that engine's CAPTCHA / consent pages,
// and how long to let it render. The extension is engine-agnostic, so adding or fixing an
// engine is an edit to the ENGINES table below — no extension reload.
//
// While this plugin is enabled it SUPERSEDES the "web" plugin: the regular Web Search &
// Fetch group is hot-unloaded and its slider is grayed out, so every web_search / web_fetch
// call lands here. Disabling it restores "web" to its saved state.
//
// Offline behaviour: if no extension is connected, the request times out, or every engine
// fails (CAPTCHA, consent page, layout change), the call FALLS BACK to the regular HTTP
// implementation exported by plugin-web.js — using the saved Web Search & Fetch settings,
// which supersession deliberately leaves untouched. Every fallback is disclosed in the tool
// result (`fallback` + `sources`), so the Think stream shows exactly what happened.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import bridge from '../services/browserBridge.js';
import { readPluginConfig, logToolCall } from './index.js';
import { runWebSearch, runWebFetch, htmlToMarkdown, parseDdgHtml } from './plugin-web.js';

// Version of the extension source shipped in this checkout. Compared with the version the
// connected extension announces in `hello`, so an un-reloaded extension is called out.
let SHIPPED_EXTENSION_VERSION = null;
try {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../extension/manifest.json', import.meta.url)), 'utf8'));
  SHIPPED_EXTENSION_VERSION = manifest.version || null;
} catch {}

function extensionOutdated() {
  const v = bridge.info.extension?.version;
  return !!(v && SHIPPED_EXTENSION_VERSION && v !== SHIPPED_EXTENSION_VERSION);
}

const DEFAULTS = { enabled: false, engines: ['duckduckgo'] };
const RESULT_LIMIT = 8;
const MIN_USEFUL_CHARS = 200;

// ── Parser helpers (linkedom) ───────────────────────

const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
const absolute = (href, base) => { try { return new URL(href, base).href; } catch { return ''; } };
const isHttp = (u) => /^https?:\/\//i.test(u);
const hostIs = (u, suffix) => { try { const h = new URL(u).hostname; return h === suffix || h.endsWith('.' + suffix); } catch { return false; } };

/**
 * Engine table. Each entry:
 *   url(query)            → results page URL to load in the hidden tab
 *   settleMs / retryDelays → render waits passed to the extension (JS-rendered pages need more)
 *   block(page)           → string reason if the page is a CAPTCHA / consent / block page, else null
 *   parse(page, limit)    → [{ title, url, description }]
 * Exactly one engine is active (radio on the card). If it fails or returns nothing, the call
 * falls back to the HTTP search — there is no chaining between browser engines, since results
 * are never merged and the fallback already provides the backup.
 */
const ENGINES = {
  duckduckgo: {
    label: 'DuckDuckGo',
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    settleMs: 200, retryDelays: [],
    block: (page) => {
      const { document } = parseHTML(page.html);
      return document.querySelector('.anomaly-modal, #challenge-form') ? 'DuckDuckGo showed a bot challenge page' : null;
    },
    parse: (page, limit) => parseDdgHtml(page.html, limit),
  },

  brave: {
    label: 'Brave',
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
    // Results render client-side; give the first paint a moment, then one more read.
    settleMs: 1200, retryDelays: [1500],
    block: (page) => (/are you a robot|verify you are human|unusual traffic/i.test(page.wallText || '') ? 'Brave Search showed a bot challenge page' : null),
    parse: (page, limit) => {
      const { document } = parseHTML(page.html);
      const out = [];
      const seen = new Set();
      const blocks = document.querySelectorAll('#results .snippet[data-type="web"], #results .snippet:not([data-type])');
      for (const el of blocks) {
        const a = el.querySelector('a[href^="http"]');
        if (!a) continue;
        const url = absolute(a.getAttribute('href'), page.url);
        if (!isHttp(url) || hostIs(url, 'brave.com') || seen.has(url)) continue;
        seen.add(url);
        const titleEl = el.querySelector('.title, .snippet-title, [class*="title"]');
        const descEl = el.querySelector('.snippet-description, .snippet-content, .description, [class*="description"]');
        out.push({ title: text(titleEl) || text(a), url, description: text(descEl) });
        if (out.length >= limit) break;
      }
      return out;
    },
  },

  bing: {
    label: 'Bing',
    url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&count=10`,
    settleMs: 300, retryDelays: [],
    block: (page) => {
      if (/\/turing\//.test(page.url || '')) return 'Bing showed a CAPTCHA page';
      const { document } = parseHTML(page.html);
      return document.querySelector('#b_captcha, form[action*="captcha"]') ? 'Bing showed a CAPTCHA page' : null;
    },
    parse: (page, limit) => {
      const { document } = parseHTML(page.html);
      // Bing wraps result links as /ck/a?...&u=a1<base64url(url)>; decode back to the real URL.
      const unwrap = (href) => {
        try {
          const u = new URL(href, page.url);
          if (u.hostname.endsWith('bing.com') && u.pathname.startsWith('/ck/')) {
            const p = u.searchParams.get('u') || '';
            if (p.startsWith('a1')) return Buffer.from(p.slice(2), 'base64url').toString('utf8');
          }
          return u.href;
        } catch { return ''; }
      };
      const out = [];
      const seen = new Set();
      for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
        const a = li.querySelector('h2 a[href]');
        if (!a) continue;
        const url = unwrap(a.getAttribute('href'));
        if (!isHttp(url) || hostIs(url, 'bing.com') || seen.has(url)) continue;
        seen.add(url);
        const descEl = li.querySelector('.b_caption p, p[class*="b_lineclamp"], .b_algoSlug, .b_paractl');
        out.push({ title: text(a), url, description: text(descEl).replace(/^WEB\s*/i, '') });
        if (out.length >= limit) break;
      }
      return out;
    },
  },

  google: {
    label: 'Google',
    url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&num=10`,
    settleMs: 300, retryDelays: [],
    block: (page) => {
      let u; try { u = new URL(page.url || ''); } catch { u = null; }
      if (u && u.pathname.startsWith('/sorry')) return 'Google showed a CAPTCHA / unusual-traffic page';
      if (u && u.hostname.startsWith('consent.')) return 'Google consent interstitial — open google.com once in this browser and accept it';
      if (/before you continue/i.test(page.title || '')) return 'Google consent interstitial — open google.com once in this browser and accept it';
      const { document } = parseHTML(page.html);
      return document.querySelector('form#captcha-form, #recaptcha') ? 'Google showed a CAPTCHA / unusual-traffic page' : null;
    },
    parse: (page, limit) => {
      const { document } = parseHTML(page.html);
      const out = [];
      const seen = new Set();
      // Organic results: an <h3> inside an anchor. Ads and "People also ask" don't match.
      for (const h3 of document.querySelectorAll('#search a h3, #rso a h3')) {
        const a = h3.closest('a');
        if (!a) continue;
        let url = absolute(a.getAttribute('href'), page.url);
        try {
          const u = new URL(url);
          if (u.pathname === '/url' && u.searchParams.get('q')) url = u.searchParams.get('q');
        } catch { continue; }
        if (!isHttp(url) || hostIs(url, 'google.com') || seen.has(url)) continue;
        seen.add(url);
        const block = a.closest('[data-hveid], .g, [jscontroller]') || a.parentElement;
        const descEl = block?.querySelector('[data-sncf], .VwiC3b, div[style*="-webkit-line-clamp"]');
        out.push({ title: text(h3), url, description: text(descEl) });
        if (out.length >= limit) break;
      }
      return out;
    },
  },
};

/** The single active engine id (first valid saved entry; default duckduckgo). */
async function getEngine() {
  const cfg = await readPluginConfig();
  const saved = cfg.browser?.engines;
  const list = (Array.isArray(saved) ? saved : []).filter(e => ENGINES[e]);
  return list[0] || DEFAULTS.engines[0];
}

function offlineReason() {
  if (bridge.connected) return null;
  if (!bridge.everConnected) return 'browser extension not connected (not installed, or Chrome is closed)';
  return `browser extension disconnected (last seen ${bridge.lastSeen?.toLocaleTimeString() || 'unknown'})`;
}

// A request in flight when the extension reconnects (worker restart, extension reload) is
// rejected with "Extension reconnected". The new connection is usually up within a second,
// so retry that one case once instead of falling back to HTTP.
async function fetchWithRetry(url, opts) {
  try {
    return await bridge.fetchPage(url, opts);
  } catch (err) {
    if (!/Extension reconnected/.test(err.message)) throw err;
    await new Promise(r => setTimeout(r, 1000));
    if (!bridge.connected) throw err;
    console.warn(`[browser] extension reconnected mid-request, retrying ${url} once`);
    return bridge.fetchPage(url, opts);
  }
}

/** Run one engine end to end: load, block check, parse. Throws with a reason on failure. */
async function searchEngine(id, query) {
  const def = ENGINES[id];
  const page = await fetchWithRetry(def.url(query), { settleMs: def.settleMs, retryDelays: def.retryDelays });
  const blocked = def.block(page);
  if (blocked) throw new Error(blocked);
  if (page.wall) throw new Error(`${def.label} showed a bot wall ("${(page.wallText || '').slice(0, 80)}")`);
  const results = def.parse(page, RESULT_LIMIT);
  return { results, ms: page.ms };
}

async function fallbackSearch(query, reason) {
  console.warn(`[browser_search] falling back to HTTP search: ${reason}`);
  logToolCall('web_search', 'browser_fallback', { args: { query }, rawResult: reason });
  const res = await runWebSearch(query);
  return { ...res, sources: `${res.sources || 'HTTP search'} (fallback: ${reason})`, fallback: reason };
}

async function fallbackFetch(url, reason) {
  console.warn(`[browser_fetch] falling back to HTTP fetch: ${reason}`);
  logToolCall('web_fetch', 'browser_fallback', { args: { url }, rawResult: reason });
  try {
    const res = await runWebFetch(url);
    return { ...res, _tier: `${res._tier || 'http'} (fallback: ${reason})`, fallback: reason };
  } catch (err) {
    // Keep the browser-side reason visible even when the HTTP path fails too.
    return { url, error: `HTTP fallback failed: ${err.message}`, fallback: reason };
  }
}

export default {
  group: 'browser',
  label: 'Browser Search',
  description: 'Runs web_search and web_fetch in a hidden tab of your own Chrome via the Lumispec Browser Search extension. Replaces Web Search & Fetch while enabled; falls back to it when the extension is offline.',
  supersedes: ['web'],
  defaults: DEFAULTS,
  configUi: () => ({
    engineMode: 'single', // radio: one engine at a time
    availableEngines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label, available: true })),
  }),
  status: {
    label: 'Browser',
    interval: 5000,
    poll: async () => (bridge.connected ? 'ok' : 'unauth'),
  },
  // Live line on the Plugins card. The viewer's own browser is irrelevant here: the
  // extension may run in Chrome while the UI is open in Firefox on the same machine.
  cardStatus: () => {
    const info = bridge.info;
    if (info.connected) {
      const v = info.extension?.version;
      const detail = v ? ` v${v}` : '';
      if (extensionOutdated()) {
        return { ok: false, text: `Extension connected${detail} — outdated, this checkout ships v${SHIPPED_EXTENSION_VERSION}. Reload it at chrome://extensions.` };
      }
      return { ok: true, text: `Extension connected${detail}` };
    }
    if (info.everConnected) {
      const seen = info.lastSeen ? new Date(info.lastSeen).toLocaleTimeString() : 'unknown';
      return { ok: false, text: `Extension disconnected (last seen ${seen}) — searches fall back to HTTP until it reconnects` };
    }
    return { ok: false, text: 'No browser extension connected — searches fall back to HTTP. Install it from extension/README.md (Chrome, Edge, Brave; load unpacked)' };
  },
  enableWarning: () => bridge.connected
    ? null
    : 'Browser Search is on, but no browser extension is connected. Install it from extension/README.md and keep that browser open. Until it connects, searches fall back to Web Search & Fetch.',
  routing: [
    '- Web questions, current events, news → use "web_search" then "web_fetch"',
  ],
  prompt: `## Web Research (via browser extension)
- web_search and web_fetch run inside the user's own browser; when the extension is offline they transparently fall back to HTTP and the result says so in "fallback".
- After web_search, try web_fetch on the most relevant result URL to get full details. If web_fetch fails (login wall, CAPTCHA, empty content), use the search snippet descriptions directly.
- Do NOT retry the same blocked site via proxy or alternate URL. Move on.
- Write web_search queries as plain keywords. Do NOT wrap phrases in quotation marks. \`site:\` is fine.
- Maximum 3 web_search calls and 3 web_fetch calls per user question. If you still lack information after that, answer with what you have and tell the user what you could not retrieve.`,
  tools: {
    web_search: {
      description: 'Search the web through the user\'s browser (results page loaded in a hidden tab). Requires a "query" argument.',
      parameters: { query: 'string' },
      execute: async ({ query }) => {
        if (!query || !String(query).trim()) return { error: 'Empty query', results: [] };
        const offline = offlineReason();
        if (offline) return fallbackSearch(query, offline);

        // One engine. If it fails or returns nothing, the HTTP fallback is the backup.
        const id = await getEngine();
        const label = ENGINES[id].label;
        try {
          const { results, ms } = await searchEngine(id, query);
          if (results.length > 0) return { results, sources: `Browser (${label}, ${ms} ms)` };
          console.warn(`[browser_search] ${label} returned no results for "${query}" (parser drift or blocked)`);
          return fallbackSearch(query, `${label}: no results`);
        } catch (err) {
          console.warn(`[browser_search] ${label} failed: ${err.message}`);
          return fallbackSearch(query, `${label}: ${err.message}`);
        }
      },
    },
    web_fetch: {
      description: 'Fetch a web page through the user\'s browser and extract its full content as markdown. Requires a "url" argument. ALWAYS use after web_search to read the most relevant result before answering.',
      parameters: { url: 'string' },
      execute: async ({ url }) => {
        if (!isHttp(url || '')) return { error: `Invalid URL: ${url}` };
        const offline = offlineReason();
        if (offline) return fallbackFetch(url, offline);

        try {
          const page = await fetchWithRetry(url, {}); // extension defaults: 0.8 s settle, +3 s, +4 s while walled/thin
          if (page.wall) {
            const snippet = (page.wallText || '').slice(0, 80);
            return fallbackFetch(url, `site showed a bot/JS challenge wall that did not clear in ${Math.round((page.ms || 0) / 1000)}s ("${snippet}")`);
          }
          const { markdown, title } = htmlToMarkdown(page.html);
          if ((markdown || '').trim().length < MIN_USEFUL_CHARS) {
            return fallbackFetch(url, `browser returned ${markdown.trim().length} chars of content after ${Math.round((page.ms || 0) / 1000)}s`);
          }
          return { url: page.url || url, title: title || page.title, content: markdown, _tier: `extension (${page.ms} ms)` };
        } catch (err) {
          return fallbackFetch(url, err.message);
        }
      },
    },
  },
};
