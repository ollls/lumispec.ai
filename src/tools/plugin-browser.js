// Browser Search — routes web_search / web_fetch through the Lumispec Browser Search
// Chrome extension (extension/), which runs the query in a hidden tab of the user's own
// browser and talks to us over the WebSocket bridge (services/browserBridge.js).
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

import bridge from '../services/browserBridge.js';
import { readPluginConfig, logToolCall } from './index.js';
import { runWebSearch, runWebFetch, htmlToMarkdown } from './plugin-web.js';

const DEFAULTS = { enabled: false, engines: ['duckduckgo'] };
const ENGINES = {
  duckduckgo: { label: 'DuckDuckGo' },
  google: { label: 'Google' },
};
const MIN_USEFUL_CHARS = 200;

async function getEngines() {
  const cfg = await readPluginConfig();
  const saved = cfg.browser?.engines;
  const list = Array.isArray(saved) && saved.length ? saved : DEFAULTS.engines;
  return list.filter(e => ENGINES[e]);
}

function offlineReason() {
  if (bridge.connected) return null;
  if (!bridge.everConnected) return 'browser extension not connected (not installed, or Chrome is closed)';
  return `browser extension disconnected (last seen ${bridge.lastSeen?.toLocaleTimeString() || 'unknown'})`;
}

// A request in flight when the extension reconnects (worker restart, extension reload) is
// rejected with "Extension reconnected". The new connection is usually up within a second,
// so retry that one case once instead of falling back to HTTP.
async function searchWithRetry(engine, query) {
  try {
    return await bridge.search(engine, query, 8);
  } catch (err) {
    if (!/Extension reconnected/.test(err.message)) throw err;
    await new Promise(r => setTimeout(r, 1000));
    if (!bridge.connected) throw err;
    console.warn(`[browser_search] extension reconnected mid-search, retrying ${engine} once`);
    return bridge.search(engine, query, 8);
  }
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
    availableEngines: Object.entries(ENGINES).map(([id, e]) => ({ id, label: e.label, available: true })),
  }),
  status: {
    label: 'Browser',
    interval: 5000,
    poll: async () => (bridge.connected ? 'ok' : 'unauth'),
  },
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
      description: 'Search the web through the user\'s browser (DuckDuckGo / Google in a hidden tab). Requires a "query" argument.',
      parameters: { query: 'string' },
      execute: async ({ query }) => {
        if (!query || !String(query).trim()) return { error: 'Empty query', results: [] };
        const offline = offlineReason();
        if (offline) return fallbackSearch(query, offline);

        // Engines run in the saved order, one at a time (the extension serializes anyway):
        // first engine with results wins, so a Google CAPTCHA just means DuckDuckGo answers.
        const engines = await getEngines();
        const errors = [];
        for (const engine of engines) {
          try {
            const { results, ms } = await searchWithRetry(engine, query);
            if (results.length > 0) {
              return { results, sources: `Browser (${ENGINES[engine].label}, ${ms} ms)` };
            }
            errors.push(`${ENGINES[engine].label}: no results`);
          } catch (err) {
            errors.push(`${ENGINES[engine].label}: ${err.message}`);
            // Extension dropped or stopped answering: the next engine would only burn another
            // timeout, so go straight to the HTTP fallback.
            if (!bridge.connected || /did not answer within/.test(err.message)) break;
          }
        }
        return fallbackSearch(query, errors.join('; ') || 'no browser engines enabled');
      },
    },
    web_fetch: {
      description: 'Fetch a web page through the user\'s browser and extract its full content as markdown. Requires a "url" argument. ALWAYS use after web_search to read the most relevant result before answering.',
      parameters: { url: 'string' },
      execute: async ({ url }) => {
        if (!/^https?:\/\//i.test(url || '')) return { error: `Invalid URL: ${url}` };
        const offline = offlineReason();
        if (offline) return fallbackFetch(url, offline);

        try {
          const page = await bridge.fetchPage(url);
          // The extension already waited through its retry schedule (~8 s) for a challenge
          // wall to clear or a client render to finish; if it is still a wall, say so.
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
