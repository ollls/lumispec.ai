// Lumispec Browser Search — MV3 service worker.
//
// The extension is deliberately engine-agnostic. It does ONE thing for the server: open a
// URL in a hidden (inactive) tab of the user's real browser, wait for it to render, return
// the live DOM's HTML plus a few generic hints (text length, bot-wall flag), close the tab.
// Which URL to open (DuckDuckGo, Google, Bing, …) and how to parse the result page is the
// server's business (src/tools/plugin-browser.js), so adding or fixing a search engine never
// requires reloading this extension.
//
// Protocol (JSON text frames over one WebSocket):
//   ext → srv  { type: 'hello', version, capabilities: ['fetch'], ua }
//   srv → ext  { type: 'fetch', id, url, maxChars?, settleMs?, retryDelays? }
//   ext → srv  { type: 'result', id, page: { title, url, html, htmlChars, text, textSource, textChars, domChars, wall, wallText?, truncated, reads }, ms }
//     html is the live DOM minus script/style/noscript/template/svg (the server discards those
//     anyway, and on Gmail / NYT they were 75-100% of the bytes); htmlChars is the raw size.
//     text is document.body.innerText — the page as laid out on screen, hidden elements excluded,
//     one line per visual row — which backs web_fetch's view: "text" (web apps such as mail or
//     dashboards, whose markup is mostly machinery and hidden labels).
//   ext → srv  { type: 'error', id, message }
//   srv → ext  { type: 'ping', id }   →   ext → srv  { type: 'pong', id }

const DEFAULTS = {
  serverUrl: 'ws://localhost:3000/ws/browser',
  token: '',
  enabled: true,
};

const PAGE_LOAD_TIMEOUT_MS = 20000;         // hard cap on waiting for the tab
const LOAD_PROBE_AFTER_MS = 4000;           // after this, accept an "interactive" page with real text
const LOAD_PROBE_EVERY_MS = 1500;
const FETCH_SETTLE_MS = 800;                // let client-rendered pages paint after "complete"
const FETCH_RETRY_DELAYS_MS = [3000, 4000]; // extra waits while the page is still thin or a bot wall
const FETCH_MIN_TEXT_CHARS = 200;           // below this the page is "thin": nothing has rendered yet
// A page past the thin line is read until its visible text stops growing. Server-rendered pages
// settle on the first probe (~0.6 s); progressive apps (Gmail paints its chrome first and the
// message list seconds later — 444 chars accepted as final on 2026-10-31) keep the loop alive.
const FETCH_STABLE_PROBE_MS = 600;          // gap between two text-length reads
const FETCH_STABLE_MAX_MS = 6000;           // give up waiting for stability after this
const FETCH_STABLE_MIN_GROWTH = 40;         // chars; smaller changes (clocks, counters) count as settled
const FETCH_MIN_VISIBLE_SHARE = 0.1;        // below this share of DOM text on screen, the page is still painting
const FETCH_MAX_CHARS_DEFAULT = 4_000_000;  // applies to the stripped HTML, so only content can hit it
const FETCH_TEXT_MAX_CHARS = 400_000;       // cap on the rendered innerText sent alongside
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// ── Hidden-tab page loading ─────────────────────────

// Runs inside the page: is the document usable even if the load event never fires? Also the cheap
// probe for the stability loop (text length + wall flag, no HTML serialization).
function probeReady(minChars) {
  try {
    // Readable DOM text: body textContent minus script/style/noscript/template contents, which
    // are text to the DOM but never to the screen (Reuters carries ~1.2M chars of inline JSON).
    function domTextChars() {
      const body = document.body;
      if (!body) return 0;
      let dead = 0;
      for (const el of body.querySelectorAll('script, style, noscript, template')) dead += (el.textContent || '').length;
      return Math.max(0, (body.textContent || '').replace(/\s+/g, ' ').trim().length - dead);
    }
    // On-screen text without relying on layout: walks the DOM and drops subtrees whose computed
    // style hides them (display none, visibility hidden, aria-hidden). innerText only returns
    // text that has layout, and in an inactive tab Chrome skips layout for virtualized lists —
    // Gmail's inbox reported 593 chars of innerText against 24K chars of readable DOM text.
    // Blocks become lines, table/grid cells are joined with " · ".
    function visibleTextWalk(max) {
      const BLOCK = /^(block|flex|grid|table|table-row|table-row-group|table-header-group|table-footer-group|table-caption|list-item|flow-root)$/;
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);
      const ROW_MAX = 240; // a row is one visual line; Gmail's snippet cell holds far more text than it shows
      const out = [];
      let line = '';
      let total = 0;
      let inRow = false;
      const flush = () => {
        let t = line.replace(/\s+/g, ' ').replace(/( · )+/g, ' · ').replace(/^ · | · $/g, '').trim();
        if (inRow && t.length > ROW_MAX) t = t.slice(0, ROW_MAX - 1) + '…';
        if (t) { out.push(t); total += t.length + 1; }
        line = '';
      };
      const walk = (node) => {
        if (total > max) return;
        if (node.nodeType === 3) { line += node.data; return; }
        if (node.nodeType !== 1 || SKIP.has(node.tagName) || node.getAttribute('aria-hidden') === 'true') return;
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const d = cs.display;
        const role = node.getAttribute('role');
        // A leaf row (no rows nested inside — layout tables such as Hacker News nest them) is one
        // visual line: inner blocks and cells join with " · " instead of breaking.
        const row = !inRow && (d === 'table-row' || role === 'row') && !node.querySelector('tr, [role="row"]');
        const block = node.tagName === 'BR' || BLOCK.test(d);
        const cell = d === 'table-cell' || role === 'gridcell' || role === 'cell' || role === 'columnheader';
        if (row) { flush(); inRow = true; }
        else if (block) { if (inRow) { if (line.trim()) line += ' · '; } else flush(); }
        else if (cell && line.trim()) line += ' · ';
        if (node.tagName !== 'BR') for (const c of node.childNodes) walk(c);
        if (row) { flush(); inRow = false; }
        else if (block && !inRow) flush();
      };
      if (document.body) walk(document.body);
      flush();
      return out.join('\n').slice(0, max);
    }
    let text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
    // DOM text that is not on screen yet (visibility: hidden, display: none). Gmail keeps its
    // loading shell at ~450 visible chars for several seconds while the inbox rows already sit
    // in the DOM hidden, so "visible text stopped growing" alone settles on the shell.
    const domChars = domTextChars();
    let walked = false;
    if (domChars > 0 && text.length < domChars * 0.1) {
      // innerText may be starved of layout rather than the page unrendered: measure by style.
      text = visibleTextWalk(400000).replace(/\s+/g, ' ').trim();
      walked = true;
    }
    const WALL = /(enable js\b|enable javascript|disable any ad ?blocker|just a moment|checking your browser|verify (that )?you are (a )?human|attention required|access denied|are you a robot|unusual traffic|press and hold)/i;
    const wall = text.length < 1500 && WALL.test(text.slice(0, 2000));
    return { readyState: document.readyState, textChars: text.length, domChars, walked, wall, usable: document.readyState !== 'loading' && text.length >= minChars };
  } catch (e) {
    // Runs inside the page: a thrown error would surface as "returned nothing" (an undefined
    // result), so report it as data instead.
    return { error: `page probe failed: ${(e && e.message) || e}` };
  }
}

/**
 * Resolve when the tab reports status "complete" — or, after LOAD_PROBE_AFTER_MS, as soon as the
 * document is past "loading" and has real text. Pages with never-ending trackers, video or
 * long-polling never reach "complete" (newsroom.amd.com sat for 20 s with the article fully
 * rendered). Rejects only if the hard cap passes with nothing usable.
 */
function waitForTabLoad(tabId, timeoutMs, minChars) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); clearInterval(prober); chrome.tabs.onUpdated.removeListener(onUpdated); fn(v); };
    const timer = setTimeout(async () => {
      // Last chance: take whatever the DOM holds now if it is usable.
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: probeReady, args: [minChars] });
        if (result?.usable) return finish(resolve, 'timeout-usable');
      } catch {}
      finish(reject, new Error(`Page did not finish loading within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') finish(resolve, 'complete');
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    let elapsed = 0;
    const prober = setInterval(async () => {
      elapsed += LOAD_PROBE_EVERY_MS;
      if (elapsed < LOAD_PROBE_AFTER_MS || done) return;
      try {
        const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId }, func: probeReady, args: [minChars] });
        if (result?.usable) finish(resolve, 'interactive');
      } catch { /* page not scriptable yet (still navigating) — keep waiting */ }
    }, LOAD_PROBE_EVERY_MS);
  });
}

let tabChain = Promise.resolve();

/** Serialized: one hidden tab at a time keeps us under site rate limits. */
function serialized(fn) {
  const p = tabChain.then(fn, fn);
  tabChain = p.catch(() => {});
  return p;
}

// Runs INSIDE the loaded page (chrome.scripting.executeScript), so it must be self-contained.
// Returns the live DOM after scripts ran, plus generic hints so the caller can tell a
// bot-challenge shell ("Please enable JS…", "Just a moment…") from a real page.
function extractPage(maxChars, textMaxChars) {
  try {
    // Readable DOM text: body textContent minus script/style/noscript/template contents, which
    // are text to the DOM but never to the screen (Reuters carries ~1.2M chars of inline JSON).
    function domTextChars() {
      const body = document.body;
      if (!body) return 0;
      let dead = 0;
      for (const el of body.querySelectorAll('script, style, noscript, template')) dead += (el.textContent || '').length;
      return Math.max(0, (body.textContent || '').replace(/\s+/g, ' ').trim().length - dead);
    }
    // On-screen text without relying on layout: walks the DOM and drops subtrees whose computed
    // style hides them (display none, visibility hidden, aria-hidden). innerText only returns
    // text that has layout, and in an inactive tab Chrome skips layout for virtualized lists —
    // Gmail's inbox reported 593 chars of innerText against 24K chars of readable DOM text.
    // Blocks become lines, table/grid cells are joined with " · ".
    function visibleTextWalk(max) {
      const BLOCK = /^(block|flex|grid|table|table-row|table-row-group|table-header-group|table-footer-group|table-caption|list-item|flow-root)$/;
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'IFRAME', 'CANVAS', 'VIDEO', 'AUDIO']);
      const ROW_MAX = 240; // a row is one visual line; Gmail's snippet cell holds far more text than it shows
      const out = [];
      let line = '';
      let total = 0;
      let inRow = false;
      const flush = () => {
        let t = line.replace(/\s+/g, ' ').replace(/( · )+/g, ' · ').replace(/^ · | · $/g, '').trim();
        if (inRow && t.length > ROW_MAX) t = t.slice(0, ROW_MAX - 1) + '…';
        if (t) { out.push(t); total += t.length + 1; }
        line = '';
      };
      const walk = (node) => {
        if (total > max) return;
        if (node.nodeType === 3) { line += node.data; return; }
        if (node.nodeType !== 1 || SKIP.has(node.tagName) || node.getAttribute('aria-hidden') === 'true') return;
        const cs = getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        const d = cs.display;
        const role = node.getAttribute('role');
        // A leaf row (no rows nested inside — layout tables such as Hacker News nest them) is one
        // visual line: inner blocks and cells join with " · " instead of breaking.
        const row = !inRow && (d === 'table-row' || role === 'row') && !node.querySelector('tr, [role="row"]');
        const block = node.tagName === 'BR' || BLOCK.test(d);
        const cell = d === 'table-cell' || role === 'gridcell' || role === 'cell' || role === 'columnheader';
        if (row) { flush(); inRow = true; }
        else if (block) { if (inRow) { if (line.trim()) line += ' · '; } else flush(); }
        else if (cell && line.trim()) line += ' · ';
        if (node.tagName !== 'BR') for (const c of node.childNodes) walk(c);
        if (row) { flush(); inRow = false; }
        else if (block && !inRow) flush();
      };
      if (document.body) walk(document.body);
      flush();
      return out.join('\n').slice(0, max);
    }
    const root = document.documentElement;
    if (!root) return { error: 'Page has no document' };
    const htmlChars = root.outerHTML.length;
    // Serialize a copy without the markup the server deletes before reading: inline scripts
    // (preloaded JSON state), stylesheets, noscript, inert templates and icon SVGs. Gmail's head
    // holds ~1.9M chars of CSS and the old cap fell inside it, so the body never left Chrome.
    const clone = root.cloneNode(true);
    for (const el of clone.querySelectorAll('script, style, noscript, template, svg')) el.remove();
    const html = clone.outerHTML;
    let rendered = document.body?.innerText || '';   // layout text: hidden elements excluded, newlines per visual row
    let text = rendered.replace(/\s+/g, ' ').trim();
    const domChars = domTextChars();
    let textSource = 'innerText';
    if (domChars > 0 && text.length < domChars * 0.1) {
      rendered = visibleTextWalk(textMaxChars);
      text = rendered.replace(/\s+/g, ' ').trim();
      textSource = 'styleWalk';
    }
    const head = text.slice(0, 2000);
    const WALL = /(enable js\b|enable javascript|disable any ad ?blocker|just a moment|checking your browser|verify (that )?you are (a )?human|attention required|access denied|are you a robot|unusual traffic|press and hold)/i;
    const wall = text.length < 1500 && WALL.test(head);
    return {
      title: document.title || '',
      url: location.href,
      html: html.length > maxChars ? html.slice(0, maxChars) : html,
      htmlChars,
      truncated: html.length > maxChars,
      text: rendered.length > textMaxChars ? rendered.slice(0, textMaxChars) : rendered,
      textChars: text.length,
      domChars,
      textSource,
      textSnippet: head.slice(0, 300),
      wall,
      wallText: wall ? head.slice(0, 160) : undefined,
    };
  } catch (e) {
    return { error: `page script failed: ${(e && e.message) || e}` }; // see probeReady
  }
}

/**
 * Open `url` in an inactive tab, wait for load + settleMs, then:
 *   - while the page is thin (under FETCH_MIN_TEXT_CHARS of text) or a bot wall, wait each delay
 *     in retryDelays and probe again (same tab — no second load);
 *   - once it has real text, probe every FETCH_STABLE_PROBE_MS until the visible text stops
 *     growing (or FETCH_STABLE_MAX_MS passes), so progressively rendered apps are read after
 *     their content arrives, not after their chrome;
 *   - then serialize the DOM once. Returns the last read even if never accepted.
 */
function runFetch(url, { maxChars = FETCH_MAX_CHARS_DEFAULT, settleMs = FETCH_SETTLE_MS, retryDelays = FETCH_RETRY_DELAYS_MS } = {}) {
  return serialized(async () => {
    if (!/^https?:\/\//i.test(url || '')) throw new Error(`Invalid URL: ${url}`);
    const started = Date.now();
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const tab = await chrome.tabs.create({ url, active: false });
    const run = async (func, ...args) => {
      const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args });
      if (!result) throw new Error('Page script returned nothing');
      if (result.error) throw new Error(result.error);
      return result;
    };
    try {
      const how = await waitForTabLoad(tab.id, PAGE_LOAD_TIMEOUT_MS, FETCH_MIN_TEXT_CHARS);
      // A page accepted before "complete" is still rendering; keep the settle wait in that case.
      await sleep(how === 'complete' ? settleMs : Math.max(settleMs, 500));
      let probe = await run(probeReady, FETCH_MIN_TEXT_CHARS);
      let reads = 1;
      const retries = [...retryDelays];
      let stableBudget = FETCH_STABLE_MAX_MS;
      for (;;) {
        if (probe.wall || probe.textChars < FETCH_MIN_TEXT_CHARS) {
          const delay = retries.shift();
          if (delay === undefined) break;             // thin/walled and out of retries: return as is
          await sleep(delay);
        } else {
          if (stableBudget <= 0) break;
          await sleep(FETCH_STABLE_PROBE_MS);
          stableBudget -= FETCH_STABLE_PROBE_MS;
        }
        const next = await run(probeReady, FETCH_MIN_TEXT_CHARS);
        reads++;
        // Most of the DOM still hidden means the app is mid-paint: keep probing within the budget.
        const stillPainting = next.domChars > 0 && next.textChars < next.domChars * FETCH_MIN_VISIBLE_SHARE;
        const settled = !next.wall && next.textChars >= FETCH_MIN_TEXT_CHARS && !stillPainting
          && Math.abs(next.textChars - probe.textChars) < Math.max(FETCH_STABLE_MIN_GROWTH, next.textChars * 0.02)
          && probe.textChars >= FETCH_MIN_TEXT_CHARS;  // the previous read must also have been a real page
        probe = next;
        if (settled) break;
      }
      const page = await run(extractPage, maxChars, FETCH_TEXT_MAX_CHARS);
      page.reads = reads;
      return { page, ms: Date.now() - started };
    } finally {
      chrome.tabs.remove(tab.id).catch(() => {});
    }
  });
}

// ── WebSocket client ────────────────────────────────

let ws = null;
let wsState = 'disconnected'; // disconnected | connecting | connected
let lastError = '';
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let connecting = false; // guards the async gap in connect() against concurrent callers

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
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  // connect() is triggered from several places at once on a worker start (top-level call,
  // onInstalled / onStartup, the keepalive alarm). The flag keeps two callers from both
  // passing the readyState check during the settings await and opening two sockets.
  connecting = true;
  let sock;
  try {
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
      sock = new WebSocket(url.toString());
    } catch (e) {
      setState('disconnected', e.message);
      scheduleReconnect();
      return;
    }
    ws = sock;
  } finally {
    connecting = false;
  }

  // Every handler checks it still owns the live socket: a stale socket's close must not
  // clobber `ws` or trigger a reconnect.
  sock.onopen = () => {
    if (ws !== sock) return;
    reconnectDelay = RECONNECT_MIN_MS;
    setState('connected');
    send({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      capabilities: ['fetch'],
      ua: navigator.userAgent,
    });
  };
  sock.onmessage = (ev) => { if (ws === sock) handleServerMessage(ev.data); };
  sock.onerror = () => { if (ws === sock) lastError = 'Connection failed'; };
  sock.onclose = (ev) => {
    if (ws !== sock) return; // superseded socket — ignore
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
    case 'fetch': {
      try {
        const opts = {};
        if (Number.isFinite(msg.maxChars)) opts.maxChars = msg.maxChars;
        if (Number.isFinite(msg.settleMs)) opts.settleMs = msg.settleMs;
        if (Array.isArray(msg.retryDelays)) opts.retryDelays = msg.retryDelays;
        const { page, ms } = await runFetch(msg.url, opts);
        send({ type: 'result', id: msg.id, page, ms });
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
        reply({ state: wsState, lastError, settings, version: chrome.runtime.getManifest().version });
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
          const { page, ms } = await runFetch(msg.url);
          // Popup only needs the hints, not a megabyte of HTML
          reply({ ok: true, ms, title: page.title, url: page.url, textChars: page.textChars, wall: page.wall, wallText: page.wallText, textSnippet: page.textSnippet, htmlChars: page.htmlChars, sentChars: page.html.length, reads: page.reads });
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
// MV3 workers are suspended when idle. An open WebSocket keeps the worker alive on
// Chrome 116+; the alarm is the safety net that re-establishes the socket after the worker
// has been killed and restarted.

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') connect();
});
connect();
