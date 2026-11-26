#!/usr/bin/env node
// Live check of the Browser Search engines — run before a release, and whenever searches start
// falling back to HTTP.
//
//   npm run check:engines                 every engine, one real query each
//   npm run check:engines -- brave bing   only these
//   npm run check:engines -- --save       also refresh test/fixtures/engines/ from the pages read
//   npm run check:engines -- --query "…"  another query (fixtures are only saved for the default)
//
// Each engine's parser depends on markup the engine changes without notice. `npm test` reads the
// saved pages in test/fixtures/engines/, so it proves the parsers still read the markup of the day
// those pages were saved — it cannot see an engine changing. This script can: it loads one results
// page per engine in a hidden tab of your Chrome (through the Browser Search extension, as
// web_search does) and judges what the parser made of it.
//
// It needs Chrome running with the extension loaded. If the app is running, the check goes
// through it (POST /api/health/browser-engines); if not, the script listens on the app's port
// itself until the extension connects.
//
// Exit code: 0 every engine read · 1 at least one engine's format drifted (fix the parser in
// src/tools/plugin-browser.js against the page saved under logs/browser-debug/) · 2 nothing
// drifted but some engine could not be checked (CAPTCHA, consent page, no extension).

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import config from '../src/config.js';
import bridge from '../src/services/browserBridge.js';
import { ENGINES, ENGINE_CHECK_QUERY, checkEngines, assessEngineResults, engineSite } from '../src/tools/plugin-browser.js';
import { reduceToResults, RESULT_ROOTS } from './engine-fixture.mjs';

const FIXTURE_DIR = resolve(fileURLToPath(new URL('../test/fixtures/engines', import.meta.url)));
const CONNECT_WAIT_MS = 45_000; // the extension retries every 30 s at most

const args = process.argv.slice(2);
const save = args.includes('--save');
const qAt = args.indexOf('--query');
const query = qAt >= 0 ? args[qAt + 1] : ENGINE_CHECK_QUERY;
const names = args.filter((a, i) => !a.startsWith('--') && (qAt < 0 || i !== qAt + 1));
const unknown = names.filter(n => !ENGINES[n]);
if (unknown.length || (qAt >= 0 && !query)) {
  console.error(unknown.length ? `Unknown engine: ${unknown.join(', ')}. Known: ${Object.keys(ENGINES).join(', ')}` : '--query needs a value');
  process.exit(64);
}
const engines = names.length ? names : Object.keys(ENGINES);
const base = `http://localhost:${config.port}`;

/** Ask the running app. Returns null when nothing listens on the port. */
async function viaApp() {
  let res;
  try {
    res = await fetch(`${base}/api/health/browser-engines`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engines, query, pages: save }),
    });
  } catch {
    return null;
  }
  if (res.status === 404) {
    throw new Error(`The app on port ${config.port} predates this check — restart it (npm start) and run this again.`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status} from the app`);
  return body.engines;
}

/** No app running: serve the extension's WebSocket on the app's port for the length of the check. */
async function standalone() {
  const server = createServer((_req, res) => { res.statusCode = 503; res.end('engine check in progress'); });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(config.port, ok); });
  bridge.attach(server);
  process.stderr.write(`App not running — waiting for the Browser Search extension on port ${config.port} `);
  const until = Date.now() + CONNECT_WAIT_MS;
  while (!bridge.info.extension && Date.now() < until) {
    await new Promise(r => setTimeout(r, 500));
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  try {
    return await checkEngines({ engines, query, keepPage: save });
  } finally {
    bridge.close();
    server.close();
    server.closeAllConnections?.();
  }
}

function saveFixture(row) {
  const def = ENGINES[row.engine];
  const html = reduceToResults(row.engine, row.page, engineSite(def));
  if (!html) return `not saved: none of ${RESULT_ROOTS[row.engine]?.join(', ') || '(no root listed)'} found — add the engine to RESULT_ROOTS in scripts/engine-fixture.mjs`;
  const page = { url: row.page.url, title: row.page.title, html };
  const results = def.parse(page, 8);
  if (JSON.stringify(results) !== JSON.stringify(row.results) || assessEngineResults(def, results).length) {
    return 'not saved: the result list alone does not parse like the whole page — adjust scripts/engine-fixture.mjs';
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(resolve(FIXTURE_DIR, `${row.engine}.html`), html);
  writeFileSync(resolve(FIXTURE_DIR, `${row.engine}.json`), JSON.stringify({
    engine: row.engine, query: row.query, url: page.url, title: page.title,
    savedAt: new Date().toISOString().slice(0, 10), results,
  }, null, 2) + '\n');
  return `saved test/fixtures/engines/${row.engine}.html (${Math.round(html.length / 1024)} KB)`;
}

const MARK = { ok: '✓', drift: '✗', blocked: '!', empty: '!', unreachable: '!' };
const HINT = {
  drift: 'the page loaded but the parser could not read it — fix the selectors, then run with --save',
  blocked: 'not checked: the engine refused this browser, which says nothing about its format',
  empty: 'not checked: the engine returned its "no results" page for a query that has results',
  unreachable: 'not checked',
};

let rows;
try {
  rows = await viaApp() ?? await standalone();
} catch (err) {
  console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is in use by something that is not the app.` : err.message);
  process.exit(2);
}

console.log(`\nBrowser Search engines — query "${query}"\n`);
for (const row of rows) {
  const time = row.ms != null ? ` · ${(row.ms / 1000).toFixed(1)} s` : '';
  console.log(`${MARK[row.status] || '?'} ${(row.label || row.engine).padEnd(11)} ${row.status.padEnd(11)} ${row.detail || ''}${time}`);
  if (HINT[row.status]) console.log(`  ${HINT[row.status]}`);
  if (row.saved) console.log(`  page saved to ${row.saved}`);
  if (row.status === 'ok' && row.results?.[0]) console.log(`  1. ${row.results[0].title} — ${row.results[0].url}`);
  if (save) {
    if (row.status !== 'ok') console.log('  fixture left as it was');
    else if (query !== ENGINE_CHECK_QUERY) console.log('  fixture left as it was (saved only for the default query)');
    else console.log(`  ${saveFixture(row)}`);
  }
}

const drifted = rows.filter(r => r.status === 'drift');
const unchecked = rows.filter(r => r.status !== 'ok' && r.status !== 'drift');
console.log(`\n${rows.length - drifted.length - unchecked.length} of ${rows.length} read correctly`
  + (drifted.length ? ` · format changed: ${drifted.map(r => r.label || r.engine).join(', ')}` : '')
  + (unchecked.length ? ` · not checked: ${unchecked.map(r => r.label || r.engine).join(', ')}` : ''));
process.exit(drifted.length ? 1 : unchecked.length ? 2 : 0);
