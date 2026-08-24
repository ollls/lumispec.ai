import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import config from '../config.js';
import { readPluginConfig } from './index.js';

// ── Lazy-loaded optional deps ───────────────────────
let _gotScraping;
async function getGotScraping() {
  if (!_gotScraping) {
    _gotScraping = (await import('got-scraping')).gotScraping;
  }
  return _gotScraping;
}

import { execSync } from 'child_process';

let _browser;
let _browserPromise;   // in-flight launch, shared by concurrent callers
let _idleTimer;
let _activePages = 0;
const BROWSER_IDLE_MS = 5 * 60 * 1000;

function findChrome() {
  if (config.chromePath) return config.chromePath;
  for (const cmd of ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium']) {
    try {
      const p = execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim();
      if (p) return p;
    } catch {}
  }
  return undefined;
}

// Close the shared browser once it has been idle — otherwise a single
// browser-mode fetch leaves headless Chrome resident for the server's lifetime.
function armIdleTimer() {
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(closeIdleBrowser, BROWSER_IDLE_MS);
  _idleTimer.unref?.();
}

async function closeIdleBrowser() {
  if (_activePages > 0) return armIdleTimer();   // still in use, check again later
  const browser = _browser;
  _browser = undefined;
  _browserPromise = undefined;
  if (browser?.connected) {
    await browser.close().catch(err => console.warn(`[web_fetch] browser close failed: ${err.message}`));
  }
}

async function getBrowser() {
  if (_browser?.connected) {
    armIdleTimer();
    return _browser;
  }
  if (_browser) {           // cached instance died — drop it and relaunch
    _browser = undefined;
    _browserPromise = undefined;
  }
  // Tool calls run up to MAX_PARALLEL_TOOLS at a time, so concurrent fetches can
  // reach this together. Share the in-flight launch instead of each starting Chrome
  // and orphaning every instance but the last.
  if (_browserPromise) return _browserPromise;

  _browserPromise = (async () => {
    const puppeteerExtra = (await import('puppeteer-extra')).default;
    const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
    puppeteerExtra.use(StealthPlugin());
    const executablePath = findChrome();
    if (!executablePath) throw new Error('No Chrome/Chromium found. Set CHROME_PATH env var or install google-chrome.');
    const browser = await puppeteerExtra.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      // page.content() issues Runtime.callFunctionOn, which has no timeout of its
      // own and otherwise inherits puppeteer's 180s default — pages that keep the
      // renderer busy (politico.com) stalled a fetch for over three minutes.
      protocolTimeout: 30000,
    });
    browser.once('disconnected', () => {
      if (_browser === browser) {
        _browser = undefined;
        _browserPromise = undefined;
      }
    });
    return browser;
  })();

  try {
    _browser = await _browserPromise;
  } catch (err) {
    _browserPromise = undefined;   // failed launch must not be cached
    throw err;
  }
  armIdleTimer();
  return _browser;
}

// ── Web config from plugins.json ────────────────────
const DEFAULTS = { mode: 'auto', engines: ['keiro'] };

async function getWebConfig() {
  const cfg = await readPluginConfig();
  const saved = cfg.web || {};
  return {
    mode: saved.mode || DEFAULTS.mode,
    engines: saved.engines || DEFAULTS.engines,
  };
}

// ── Search engine backends ───────────────────────────
async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.tavily.apiKey}`,
    },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[web_search] Tavily returned ${res.status}: ${body}`);
    return { error: `Search failed (HTTP ${res.status})`, results: [] };
  }
  const data = await res.json();
  return { results: (data.results || []).map(r => ({ title: r.title, url: r.url, description: r.content || '' })) };
}

async function searchKeiro(query) {
  const res = await fetch(`${config.keiro.baseUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: config.keiro.apiKey, query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[web_search] Keiro returned ${res.status}: ${body}`);
    return { error: `Search failed (HTTP ${res.status})`, results: [] };
  }
  const data = await res.json();
  const results = data.data?.search_results || [];
  return { results: results.slice(0, 5).map(r => ({ title: r.title || '', url: r.url || '', description: r.snippet || '' })) };
}

async function ddgScrape(query) {
  const gotScraping = await getGotScraping();
  const res = await gotScraping({
    url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    headerGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['linux'], devices: ['desktop'] },
    timeout: { request: 15000 },
    followRedirect: true,
  });
  const { document } = parseHTML(res.body);
  const results = [];
  for (const el of document.querySelectorAll('.result')) {
    const anchor = el.querySelector('.result__a');
    const snippet = el.querySelector('.result__snippet');
    if (!anchor) continue;
    const href = anchor.getAttribute('href') || '';
    const match = href.match(/uddg=([^&]+)/);
    const finalUrl = match ? decodeURIComponent(match[1]) : href;
    if (!finalUrl || finalUrl.startsWith('/')) continue;
    results.push({
      title: anchor.textContent?.trim() || '',
      url: finalUrl,
      description: snippet?.textContent?.trim() || '',
    });
    if (results.length >= 5) break;
  }
  return results;
}

async function searchDDG(query) {
  let results = await ddgScrape(query);
  // DDG's HTML endpoint returns nothing for quoted phrases, which the LLM writes out
  // of Google habit. Retry unquoted only when the alternative is an empty result set,
  // so a quoted search that does work is never silently broadened.
  if (!results.length && query.includes('"')) {
    const unquoted = query.replace(/"/g, ' ').replace(/\s+/g, ' ').trim();
    if (unquoted) {
      console.warn(`[web_search] DDG empty for quoted query, retrying without quotes: ${unquoted}`);
      results = await ddgScrape(unquoted);
    }
  }
  if (!results.length) {
    console.warn('[web_search] DDG returned no parseable results (layout change or blocked)');
    return { error: 'No results parsed (DDG may have changed layout or blocked)', results: [] };
  }
  return { results };
}

const SEARCH_BACKENDS = {
  tavily: { fn: searchTavily, label: 'Tavily' },
  keiro: { fn: searchKeiro, label: 'Keiro' },
  duckduckgo: { fn: searchDDG, label: 'DuckDuckGo' },
};

// ── Fetch helpers ───────────────────────────────────
async function fetchRegular(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LLM-Workbench/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000),
  });
  return await res.text();
}

async function fetchStealth(url) {
  const gotScraping = await getGotScraping();
  const res = await gotScraping({
    url,
    headerGeneratorOptions: { browsers: ['chrome'], operatingSystems: ['linux'], devices: ['desktop'] },
    timeout: { request: 15000 },
    followRedirect: true,
  });
  return res.body;
}

const FETCHERS = { regular: fetchRegular, stealth: fetchStealth, browser: fetchBrowser };

// "enable JS" is the common phrasing in the wild — "enable javascript" alone misses it.
const JS_WALL = /(enable js\b|enable javascript|just a moment|checking your browser|verify you are human|attention required)/i;
const MIN_USEFUL_CHARS = 200;

async function fetchTier(tier, url) {
  const fetcher = FETCHERS[tier] || fetchRegular;
  const { markdown, title } = htmlToMarkdown(await fetcher(url));
  return { url, title, content: markdown, _tier: tier };
}

function looksBlocked({ content }) {
  return content.length < MIN_USEFUL_CHARS || JS_WALL.test(content.slice(0, 500));
}

// Output is Readability -> Turndown -> truncated text, so these never reach the LLM.
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

async function fetchBrowser(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  _activePages++;
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const handler = BLOCKED_RESOURCES.has(req.resourceType()) ? req.abort() : req.continue();
      handler.catch(() => {});   // request may already be handled/gone
    });
    try {
      // domcontentloaded + a short settle: networkidle2 stalls the full 15s on
      // ad/analytics-heavy pages for markup we already have.
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
    } catch (navErr) {
      // Fall back to whatever loaded rather than failing the fetch outright
      if (navErr.name === 'TimeoutError') {
        console.warn(`[web_fetch] navigation timeout for ${url}, using partial content`);
      } else {
        throw navErr;
      }
    }
    return await page.content();
  } finally {
    _activePages--;
    await page.close().catch(() => {});
    armIdleTimer();
  }
}

function htmlToMarkdown(html) {
  const { document } = parseHTML(html);
  const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  turndown.remove(['script', 'style', 'noscript']);

  const article = new Readability(document).parse();

  let markdown, title;
  if (article && article.content) {
    markdown = turndown.turndown(article.content);
    title = article.title;
  } else {
    const { document: doc2 } = parseHTML(html);
    for (const sel of ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside']) {
      doc2.querySelectorAll(sel).forEach(el => el.remove());
    }
    markdown = turndown.turndown(doc2.toString());
    title = doc2.querySelector('title')?.textContent || '';
  }

  const maxLen = 4000;
  if (markdown.length > maxLen) {
    markdown = markdown.slice(0, maxLen) + '\n\n[...truncated]';
  }
  return { markdown, title };
}

export default {
  group: 'web',
  label: 'Web Search & Fetch',
  description: 'Web search and page fetching with configurable engines and fetch modes.',
  defaults: { enabled: true, mode: 'stealth', engines: ['keiro'] },
  routing: [
    '- Web questions, current events, news → use "web_search" then "web_fetch"',
  ],
  prompt: `## Web Research
- After web_search, try web_fetch on the most relevant result URL to get full details. If web_fetch fails (Cloudflare block, login wall, "enable JavaScript", empty content), use the search snippet descriptions directly — they often contain the data you need.
- Do NOT retry the same blocked site via proxy or alternate URL. Move on.
- Write web_search queries as plain keywords. Do NOT wrap phrases in quotation marks — the search backend returns no results for quoted phrases. \`site:\` is fine.
- Maximum 3 web_search calls and 3 web_fetch calls per user question. If you still lack information after that, answer with what you have and tell the user what you could not retrieve.`,
  tools: {
    web_search: {
      description: 'Search the web. Requires a "query" argument.',
      parameters: { query: 'string' },
      execute: async ({ query }) => {
        const { engines } = await getWebConfig();
        const active = engines.filter(e => !!SEARCH_BACKENDS[e]);

        if (active.length === 0) {
          return { error: 'No search engines configured or available', results: [] };
        }

        if (active.length === 1) {
          const backend = SEARCH_BACKENDS[active[0]];
          const res = await backend.fn(query).catch(e => {
            console.warn(`[web_search] ${backend.label} error: ${e.message}`);
            return { error: e.message, results: [] };
          });
          return { ...res, sources: backend.label };
        }

        // Multiple engines — run in parallel, merge and deduplicate
        const results = await Promise.all(
          active.map(e => {
            const backend = SEARCH_BACKENDS[e];
            return backend.fn(query)
              .then(r => ({ ...r, engine: backend.label }))
              .catch(err => {
                console.warn(`[web_search] ${backend.label} error: ${err.message}`);
                return { error: err.message, results: [], engine: backend.label };
              });
          })
        );

        const succeeded = results.filter(r => r.results.length > 0);
        const sources = succeeded.length > 0
          ? succeeded.map(r => r.engine).join(' + ')
          : results.map(r => `${r.engine} failed`).join(', ');

        const seen = new Set();
        const merged = [];
        for (const r of results.flatMap(r => r.results)) {
          if (!seen.has(r.url)) {
            seen.add(r.url);
            merged.push(r);
          }
        }
        return { results: merged.slice(0, 8), sources };
      },
    },
    web_fetch: {
      description: 'Fetch a web page and extract its full content as markdown. Requires a "url" argument. ALWAYS use after web_search to read the most relevant result before answering.',
      parameters: { url: 'string' },
      execute: async ({ url }) => {
        const { mode } = await getWebConfig();
        if (mode !== 'auto') return fetchTier(mode, url);

        // Tier A — one HTTP request, no JS. Serves the large majority of pages.
        let cheap = null;
        try {
          cheap = await fetchTier('stealth', url);
          if (!looksBlocked(cheap)) return cheap;
        } catch (err) {
          console.warn(`[web_fetch] stealth tier failed for ${url}: ${err.message}`);
        }

        // Tier B — real browser. Only for pages that need JS or refused tier A.
        let rich;
        try {
          rich = await fetchTier('browser', url);
        } catch (err) {
          console.warn(`[web_fetch] browser tier failed for ${url}: ${err.message}`);
          if (cheap) return cheap;
          throw err;
        }
        // Hard-blocked sites answer Chrome with an empty shell, which is worse than
        // the challenge page tier A got — keep whichever actually carries content.
        if (cheap && rich.content.length < cheap.content.length) return cheap;
        return rich;
      },
    },
  },
};
