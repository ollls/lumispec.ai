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

import { readFileSync, mkdirSync, writeFileSync, accessSync, constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join, delimiter as pathDelimiter } from 'node:path';
import { parseHTML } from 'linkedom';
import config from '../config.js';
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

// ── Install helper ──────────────────────────────────────────────────────────────────────
// Chrome cannot install an unpacked extension from a web page, and branded Chrome 137+
// ignores --load-extension, so "fully automatic" is off the table. The next best thing: the
// server runs on the same machine as the browser, so a card button can open
// chrome://extensions in the user's Chrome and the file manager on extension/, leaving the
// user two clicks (Developer mode, Load unpacked → pick the folder, or drag the folder in).
const EXTENSION_DIR = fileURLToPath(new URL('../../extension/', import.meta.url)).replace(/[\\/]$/, '');

// Chromium-family executables, in preference order, when BROWSER_SEARCH_BROWSER is unset.
const BROWSER_CANDIDATES = [
  'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
  'brave-browser', 'microsoft-edge', 'microsoft-edge-stable',
];

function findOnPath(cmd) {
  if (cmd.includes('/') || cmd.includes('\\')) {
    try { accessSync(cmd, fsConstants.X_OK); return cmd; } catch { return null; }
  }
  for (const dir of (process.env.PATH || '').split(pathDelimiter)) {
    if (!dir) continue;
    const full = join(dir, cmd);
    try { accessSync(full, fsConstants.X_OK); return full; } catch {}
  }
  return null;
}

function detectBrowser() {
  const override = config.browserSearch.browserCommand;
  if (override) return { cmd: findOnPath(override), name: override };
  for (const c of BROWSER_CANDIDATES) {
    const found = findOnPath(c);
    if (found) return { cmd: found, name: c };
  }
  return { cmd: null, name: null };
}

// Fire-and-forget launch: a running Chrome instance takes the URL as a new tab; a closed one
// starts up. Edge rewrites chrome:// to edge://, Brave accepts chrome:// as is.
function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

function openInBrowser(url) {
  if (process.platform === 'win32') {
    spawnDetached('cmd', ['/c', 'start', '', config.browserSearch.browserCommand || 'chrome', url]);
    return { ok: true, message: `Opened ${url} in Chrome` };
  }
  if (process.platform === 'darwin') {
    spawnDetached('open', ['-a', config.browserSearch.browserCommand || 'Google Chrome', url]);
    return { ok: true, message: `Opened ${url} in Chrome` };
  }
  const { cmd, name } = detectBrowser();
  if (!cmd) {
    return { ok: false, message: `No Chromium-family browser found on PATH (tried ${BROWSER_CANDIDATES.join(', ')}). Set BROWSER_SEARCH_BROWSER in .env, or open ${url} by hand.` };
  }
  spawnDetached(cmd, [url]);
  return { ok: true, message: `Opened ${url} in ${name}` };
}

function openFolder(dir) {
  if (process.platform === 'win32') spawnDetached('explorer', [dir]);
  else if (process.platform === 'darwin') spawnDetached('open', [dir]);
  else {
    const xdg = findOnPath('xdg-open');
    if (!xdg) return { ok: false, message: `xdg-open not found — the folder is ${dir}` };
    spawnDetached(xdg, [dir]);
  }
  return { ok: true, message: `Opened ${dir} in the file manager — drag the folder onto the chrome://extensions page, or use Load unpacked` };
}

function installHelp() {
  const info = bridge.info;
  if (info.connected && !extensionOutdated()) return null;
  const reloading = info.connected; // connected but outdated
  return {
    title: reloading ? 'Reload the extension' : 'Install the extension',
    steps: reloading
      ? ['Open chrome://extensions and find "Lumispec Browser Search".', 'Click its ↻ Reload button.']
      : [
          'Open chrome://extensions (button below) and turn on Developer mode, top right.',
          `Click Load unpacked and pick the folder below — or drag the folder from the file manager onto the page.`,
          'Keep that browser open. This card turns green as soon as the extension connects.',
        ],
    path: EXTENSION_DIR,
    buttons: [
      { id: 'open-extensions', label: 'Open chrome://extensions', title: 'Opens the extensions page in your Chrome (new tab if Chrome is already running)' },
      ...(reloading ? [] : [
        { id: 'open-folder', label: 'Open extension folder', title: 'Opens the extension folder in your file manager so you can drag it onto the extensions page' },
        { id: 'copy-path', label: 'Copy path', title: 'Copies the extension folder path for the Load unpacked dialog', copy: EXTENSION_DIR },
      ]),
    ],
  };
}

async function runInstallAction(id) {
  if (id === 'open-extensions') return openInBrowser('chrome://extensions/');
  if (id === 'open-folder') return openFolder(EXTENSION_DIR);
  return { error: `Unknown action: ${id}` };
}

const DEFAULTS = { enabled: false, engines: ['duckduckgo'], dumpPages: false };
const RESULT_LIMIT = 8;
const MIN_USEFUL_CHARS = 200;
// Visible text Chrome itself reported, above which a page is real whatever the extractor made of
// it. The HTTP fallback runs without the browser's cookies, so re-fetching a real page from a
// signed-in site hands the model a login screen (Gmail, 2026-10-31: inbox title in Chrome,
// "Use Guest mode" from the fallback, model concluded the user was logged out).
const REAL_PAGE_MIN_TEXT = 500;
const DEBUG_DIR = resolve(fileURLToPath(new URL('../../logs/browser-debug', import.meta.url)));
const RECENT_FAILURE_TTL_MS = 90_000;

/**
 * When a parser finds nothing on a page the extension returned, save that page so the
 * selectors can be fixed against the real markup (the server itself cannot load these
 * engines — Brave answers it with HTTP 429). Returns the saved path or null.
 */
function dumpPage(tag, page) {
  try {
    mkdirSync(DEBUG_DIR, { recursive: true });
    const file = resolve(DEBUG_DIR, `${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.html`);
    const head = `<!-- url: ${page.url}\n     title: ${page.title}\n     textChars: ${page.textChars} wall: ${page.wall} -->\n`;
    writeFileSync(file, head + (page.html || '').slice(0, 3_000_000));
    return file.replace(resolve(DEBUG_DIR, '../..') + '/', '');
  } catch (err) {
    console.warn(`[browser] could not save debug page: ${err.message}`);
    return null;
  }
}

// URLs whose fetch just failed. The LLM tends to retry the same URL straight away, which
// used to cost another 20 s extension wait plus a 15 s HTTP fallback; now the second attempt
// gets the cached reason immediately.
const recentFetchFailures = new Map(); // url → { reason, at }
function recentFailure(url) {
  const e = recentFetchFailures.get(url);
  if (!e) return null;
  if (Date.now() - e.at > RECENT_FAILURE_TTL_MS) { recentFetchFailures.delete(url); return null; }
  return e;
}

// ── Parser helpers (linkedom) ───────────────────────

const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

/** Visible-ish text of a returned page (first 3000 chars), for wall / block detection. */
function pageText(page) {
  try {
    const { document } = parseHTML(page.html || '');
    for (const el of document.querySelectorAll('script, style, noscript')) el.remove();
    return `${page.title || ''} ${text(document.body)}`.slice(0, 3000);
  } catch { return page.title || ''; }
}

/**
 * Visible text of a returned page in reading order, one line per block, capped. Used when the
 * article extractor finds nothing in a page the browser rendered: worse than markdown, far
 * better than a cookie-less re-fetch.
 */
export function visibleText(html, cap = 4000) {
  try {
    const broken = (html || '').replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|td|th|dd|dt|blockquote|pre|label)>|<br\s*\/?>/gi, '$&\n');
    const { document } = parseHTML(broken);
    for (const el of document.querySelectorAll('script, style, noscript, template, svg')) el.remove();
    const lines = (document.body?.textContent || document.documentElement?.textContent || '')
      .split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = [];
    let len = 0;
    for (const l of lines) {
      if (out.length && out[out.length - 1] === l) continue;   // repeated labels
      if (len + l.length > cap) { out.push('[...truncated]'); break; }
      out.push(l); len += l.length + 1;
    }
    return out.join('\n');
  } catch { return ''; }
}

/** A short page that reads like a sign-in screen. Checked on HTTP fallback results only. */
export function looksLikeLoginPage(res) {
  const content = (res?.content || '').trim();
  if (!content || content.length > 2500) return false;
  const t = `${res.title || ''} ${content}`.slice(0, 3000);
  return /\b(sign in|log ?in|use guest mode|not your computer|enter your (email|password|phone)|forgot (your )?(password|email)|create (an )?account|verify it.?s you|session (has )?expired)\b/i.test(t);
}

// Generic challenge / block pages, checked server-side on every returned page. The extension's
// own wall regex (used for its in-tab retry) is a subset; this list is the one that produces the
// user-facing reason, and it can be extended without an extension reload. First match wins.
const WALL_PATTERNS = [
  [/not a bot|verifying you|quick check before you continue/i,
    'site is running a "not a bot" check on this browser — open it in a normal tab, pass the check once, then retry'],
  [/request has been refused|request refused|access denied|you have been blocked/i,
    'site refused the request (IP-level block, usually temporary) — switch engine or wait a while before retrying'],
  [/verify (that )?you are (a )?human|are you a robot|press and hold/i,
    'site showed a CAPTCHA — solve it once in a normal tab, then retry'],
  [/unusual traffic|automated (queries|requests)/i,
    'site flagged unusual traffic from this address — wait before retrying'],
  [/just a moment|checking your browser|attention required/i,
    'site showed a browser-check interstitial that did not clear'],
  [/enable javascript|enable js\b|disable any ad ?blocker/i,
    'site showed an "enable JavaScript" shell instead of content'],
];

// Challenge pages that render inside a cross-origin iframe leave the main document with no text
// at all, so the phrase list never sees them: Reuters answered the hidden tab with a DataDome
// CAPTCHA iframe (2026-10-31), textChars 0, and the fetch was reported as "11 chars of content".
const CHALLENGE_FRAME_RE = /captcha-delivery\.com|datadome|challenges\.cloudflare\.com|hcaptcha\.com|recaptcha|perimeterx|px-cdn\.net|arkoselabs|funcaptcha/i;
function challengeFrame(document) {
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.getAttribute('src') || '';
    const title = f.getAttribute('title') || '';
    if (!CHALLENGE_FRAME_RE.test(src) && !/captcha|challenge/i.test(title)) continue;
    const id = `${src} ${title}`;
    const vendor = /captcha-delivery|datadome/i.test(id) ? 'DataDome' : /cloudflare/i.test(id) ? 'Cloudflare' : /hcaptcha/i.test(id) ? 'hCaptcha'
      : /recaptcha/i.test(id) ? 'reCAPTCHA' : /perimeterx|px-cdn/i.test(id) ? 'PerimeterX' : /arkose|funcaptcha/i.test(id) ? 'Arkose' : 'a';
    return `site showed ${vendor} CAPTCHA (in an iframe) — open it in a normal tab, pass the check once, then retry`;
  }
  return null;
}

/** Returns a reason string if the page looks like a challenge / block page, else null. Exported for tests. */
export function detectWall(page) {
  const t = pageText(page);
  // Real pages mention these words (and embed CAPTCHA widgets in forms); only a thin page counts as a wall.
  if (t.length > 2500 && (page.textChars ?? t.length) > 1500) return null;
  try {
    const frame = challengeFrame(parseHTML(page.html || '').document);
    if (frame) return frame;
  } catch { /* unparseable html: fall through to the text patterns */ }
  if (!t) return null;
  for (const [re, msg] of WALL_PATTERNS) if (re.test(t)) return msg;
  return null;
}
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
export const ENGINES = {
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
    // Brave is the strictest engine about automation. Two distinct pages seen 2026-10-25:
    // a "Verifying you're not a bot — Quick check before you continue searching" page with a
    // Verify button (profile-level; one manual click clears it), then, after repeated unanswered
    // checks, "Your request has been refused by the server" (IP-level; only waiting clears it).
    block: (page) => {
      const t = pageText(page);
      if (/request has been refused|request refused/i.test(t)) {
        return 'Brave refused the request from this address (IP-level block, usually lifts within minutes to hours of no further requests) — switch the engine to DuckDuckGo or Google for now and try Brave again later';
      }
      if (/not a bot|quick check before you continue/i.test(t)) {
        return 'Brave is bot-checking this browser ("Verifying you\'re not a bot") — open search.brave.com in a normal tab, run any query and click Verify once; the hidden tab then inherits the cookie. Do not retry Brave until then: repeated unanswered checks escalate to a refusal';
      }
      if (/are you a robot|verify you are human|unusual traffic/i.test(t)) return 'Brave Search showed a bot challenge page';
      return null;
    },
    // Live markup (saved 2026-10-25): <div class="snippet" data-type="web"> > .result-body >
    // .result-wrapper > .result-content > a.l1[href] > (.site-name-wrapper, .title.search-snippet-title)
    // and a sibling .generic-snippet > .content whose text starts with a "<n> days ago -" span.
    // Video/news clusters are data-type="cluster" and are skipped. There is no #results wrapper.
    parse: (page, limit) => {
      const { document } = parseHTML(page.html);
      const out = [];
      const seen = new Set();
      const blocks = document.querySelectorAll('.snippet[data-type="web"], #results .snippet:not([data-type])');
      for (const el of blocks) {
        const a = el.querySelector('a.l1[href^="http"], .result-content a[href^="http"], a[href^="http"]:not(.thumbnail)');
        if (!a) continue;
        const url = absolute(a.getAttribute('href'), page.url);
        if (!isHttp(url) || hostIs(url, 'brave.com') || seen.has(url)) continue;
        seen.add(url);
        const titleEl = el.querySelector('.title, .search-snippet-title, .snippet-title');
        const descEl = el.querySelector('.generic-snippet .content, .snippet-description, .snippet-content, .description');
        // Drop the leading age span ("2 days ago -") so the snippet starts with the text.
        for (const age of descEl?.querySelectorAll('.t-secondary') || []) age.remove();
        const description = text(descEl).replace(/^-\s*/, '');
        out.push({ title: text(titleEl) || text(a), url, description });
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
  const blocked = def.block(page) || detectWall(page);
  if (blocked) throw new Error(blocked);
  if (page.wall) throw new Error(`${def.label} showed a bot wall ("${(page.wallText || '').slice(0, 80)}")`);
  const results = def.parse(page, RESULT_LIMIT);
  if (results.length === 0) {
    const saved = dumpPage(id, page);
    throw new Error(`no results${saved ? ` (page saved to ${saved} for selector repair)` : ''}`);
  }
  return { results, ms: page.ms };
}

async function fallbackSearch(query, reason) {
  console.warn(`[browser_search] falling back to HTTP search: ${reason}`);
  logToolCall('web_search', 'browser_fallback', { args: { query }, rawResult: reason });
  const res = await runWebSearch(query);
  return { ...res, sources: `${res.sources || 'HTTP search'} (fallback: ${reason})`, fallback: reason };
}

async function fallbackFetch(url, reason, page = null) {
  console.warn(`[browser_fetch] falling back to HTTP fetch: ${reason}`);
  logToolCall('web_fetch', 'browser_fallback', { args: { url }, rawResult: reason });
  try {
    const res = await runWebFetch(url);
    const out = { ...res, _tier: `${res._tier || 'http'} (fallback: ${reason})`, fallback: reason };
    if (looksLikeLoginPage(res)) {
      // The fallback has no browser session. A sign-in page here is a property of the fallback,
      // not of the user's login state, and the model must not report it as one.
      out.loginWall = true;
      out.note = 'This sign-in page came from the HTTP fallback, which has no browser cookies. It is NOT evidence that the user is logged out. '
        + (page?.title
          ? `The user's browser did load this URL and reached "${page.title}" (${page.textChars || 0} chars of visible text); its content could not be extracted (${reason}).`
          : `The browser could not load the page this time (${reason}); retry later rather than asking the user to sign in.`);
    }
    return out;
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
    fields: [
      // Parser work needs the real markup the extension saw; the fetch-thin dump only covers pages
      // the extractor failed on outright, not pages it read badly (headlines missing, player junk).
      { key: 'dumpPages', label: 'Save every fetched page to logs/browser-debug/', type: 'boolean', note: 'For extractor debugging. Files are gitignored; turn off when done.' },
    ],
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
    return { ok: false, text: 'No browser extension connected — searches fall back to HTTP. Install it with the steps below (Chrome, Edge, Brave; load unpacked)' };
  },
  // Install / reload guide with buttons, shown under the status line until the extension
  // connects. Buttons run through POST /api/plugins/browser/action/:id → cardAction().
  cardActions: installHelp,
  cardAction: runInstallAction,
  enableWarning: () => bridge.connected
    ? null
    : 'Browser Search is on, but no browser extension is connected. Install it with the buttons on this card and keep that browser open. Until it connects, searches fall back to Web Search & Fetch.',
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
          return { results, sources: `Browser (${label}, ${ms} ms)` };
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

        const recent = recentFailure(url);
        if (recent) {
          const ago = Math.round((Date.now() - recent.at) / 1000);
          return { url, error: `This URL already failed ${ago}s ago (${recent.reason}). Not retried — use another source or the search snippets.`, fallback: recent.reason, notRetried: true };
        }

        try {
          const page = await fetchWithRetry(url, {}); // extension defaults: settle, thin retries, then read until the text stops growing
          const secs = Math.round((page.ms || 0) / 1000);
          if ((await readPluginConfig()).browser?.dumpPages) {
            let host = 'page'; try { host = new URL(page.url || url).hostname.replace(/^www\./, ''); } catch {}
            const saved = dumpPage(`fetch-${host}`, page);
            if (saved) console.log(`[browser_fetch] dumpPages: saved ${saved}`);
          }
          if (page.wall) {
            const snippet = (page.wallText || '').slice(0, 80);
            return fallbackFetch(url, `site showed a bot/JS challenge wall that did not clear in ${secs}s ("${snippet}")`, page);
          }
          const walled = detectWall(page);
          if (walled) return fallbackFetch(url, `${walled} (after ${secs}s)`, page);
          const { markdown, title } = htmlToMarkdown(page.html, page.url || url);
          const tier = `extension (${page.ms} ms${page.reads > 1 ? `, ${page.reads} reads` : ''})`;
          if ((markdown || '').trim().length >= MIN_USEFUL_CHARS) {
            return { url: page.url || url, title: title || page.title, content: markdown, _tier: tier };
          }
          // The extractor found nothing in a page Chrome rendered. Keep the page: this is a parser
          // problem and the reason alone cannot be debugged after the fact.
          const saved = dumpPage('fetch-thin', page);
          const detail = `page had ${page.textChars ?? '?'} chars of visible text${page.truncated ? ', HTML truncated at the extension cap' : ''}${saved ? `; saved to ${saved}` : ''}`;
          const text = (page.textChars || 0) >= REAL_PAGE_MIN_TEXT ? visibleText(page.html) : '';
          if (text.length >= MIN_USEFUL_CHARS) {
            // Chrome saw a real page. Hand over its visible text; never swap the user's session
            // for a cookie-less re-fetch of a page that already loaded.
            return {
              url: page.url || url, title: page.title || title, content: text,
              _tier: `${tier}, visible text: article extraction found nothing (${detail})`,
              note: 'Content is the page\'s visible text in reading order, not an extracted article.',
            };
          }
          return fallbackFetch(url, `browser returned ${(markdown || '').trim().length} chars of content after ${secs}s (${detail})`, page);
        } catch (err) {
          const res = await fallbackFetch(url, err.message);
          if (res.error) recentFetchFailures.set(url, { reason: err.message, at: Date.now() });
          return res;
        }
      },
    },
  },
};
