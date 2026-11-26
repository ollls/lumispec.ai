// Every Browser Search engine against a real results page.
//
// test/fixtures/engines/<engine>.html is the result list of a page that engine served (saved by
// `npm run check:engines -- --save`, header and scripts removed); <engine>.json is what the parser
// made of it that day. These tests fail when a change to a parser — or to a helper it shares —
// stops reading markup the engine really serves, and when an engine is added without a page.
//
// They cannot see an engine changing its markup: for that, run `npm run check:engines` (live,
// through the extension) before a release. When it reports drift, fix the parser, run it with
// --save, and commit the new page together with the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ENGINES, ENGINE_CHECK_MIN_RESULTS, assessEngineResults, checkEngine, checkEngines, engineSite } from '../src/tools/plugin-browser.js';

const DIR = fileURLToPath(new URL('./fixtures/engines/', import.meta.url));
const load = (id) => {
  const meta = JSON.parse(readFileSync(DIR + id + '.json', 'utf8'));
  return { meta, page: { url: meta.url, title: meta.title, html: readFileSync(DIR + id + '.html', 'utf8'), textChars: 5000, wall: false } };
};

for (const [id, def] of Object.entries(ENGINES)) {
  test(`${def.label}: has a saved results page`, () => {
    assert.ok(existsSync(DIR + id + '.html') && existsSync(DIR + id + '.json'),
      `no fixture for "${id}" — run: npm run check:engines -- ${id} --save`);
  });

  test(`${def.label}: parser reads its saved results page`, { skip: !existsSync(DIR + id + '.json') }, () => {
    const { meta, page } = load(id);
    const results = def.parse(page, 8);
    assert.deepEqual(assessEngineResults(def, results), [], 'the parsed list does not look like a result list');
    assert.ok(results.length >= ENGINE_CHECK_MIN_RESULTS);
    assert.deepEqual(results, meta.results, `parser output changed for the page saved ${meta.savedAt}`);
  });

  test(`${def.label}: a results page is not taken for a block or "no results" page`, { skip: !existsSync(DIR + id + '.json') }, () => {
    const { page } = load(id);
    assert.equal(def.block(page), null);
    assert.equal(def.empty?.(page) ?? false, false);
  });

  test(`${def.label}: the limit is respected`, { skip: !existsSync(DIR + id + '.json') }, () => {
    assert.equal(def.parse(load(id).page, 3).length, 3);
  });
}

test('no fixture is left behind for an engine that no longer exists', () => {
  const stray = readdirSync(DIR).map(f => f.replace(/\.(html|json)$/, '')).filter(id => !ENGINES[id]);
  assert.deepEqual([...new Set(stray)], []);
});

// ── The live check's verdicts, with a fake extension ──────────────────────────────────────────

const good = (n) => Array.from({ length: n }, (_, i) => ({ title: `T${i}`, url: `https://site${i}.example/p`, description: `d${i}` }));

test('engineSite is the engine\'s own domain', () => {
  assert.deepEqual(Object.values(ENGINES).map(engineSite), ['duckduckgo.com', 'brave.com', 'bing.com', 'google.com']);
});

test('assessEngineResults: a full list passes, each defect is named', () => {
  const def = ENGINES.brave;
  assert.deepEqual(assessEngineResults(def, good(8)), []);
  assert.match(assessEngineResults(def, []).join(), /0 results, expected at least 5/);
  assert.match(assessEngineResults(def, good(2)).join(), /2 results/);
  // The Brave break of 2026-11-22 as it would look had the parser kept the redirect links.
  assert.match(assessEngineResults(def, good(6).map(r => ({ ...r, url: 'https://search.brave.com/go/v1#abc' }))).join(), /6 of 6 without a usable address.*duplicate/);
  assert.match(assessEngineResults(def, good(6).map(r => ({ ...r, title: '' }))).join(), /6 of 6 without a title/);
  assert.match(assessEngineResults(def, good(6).map((r, i) => (i < 4 ? { ...r, description: '' } : r))).join(), /4 of 6 without a description/);
  assert.deepEqual(assessEngineResults(def, good(6).map((r, i) => (i < 3 ? { ...r, description: '' } : r))), []); // some engines omit a few
});

test('checkEngine: ok on a real page, with the page kept on request', async () => {
  const { page, meta } = load('bing');
  const row = await checkEngine('bing', meta.query, { keepPage: true, deps: { fetchPage: async () => ({ ...page, ms: 1200 }) } });
  assert.equal(row.status, 'ok');
  assert.equal(row.ms, 1200);
  assert.deepEqual(row.results, meta.results);
  assert.equal(row.page.html, page.html);
});

test('checkEngine: markup the parser cannot read is drift', async () => {
  const { page } = load('bing');
  const renamed = { ...page, html: page.html.replaceAll('b_algo', 'b_algo2') };
  const row = await checkEngine('bing', 'q', { dump: false, deps: { fetchPage: async () => renamed } });
  assert.equal(row.status, 'drift');
  assert.match(row.detail, /0 results, expected at least 5/);
});

test('checkEngine: Brave links nobody resolved are drift, with the cause named', async () => {
  const { page } = load('brave');
  const cloaked = { ...page, html: page.html.replace(/ data-resolved-href="[^"]*"/g, ''), links: { asked: 12, resolved: 0, ms: 90 } };
  const row = await checkEngine('brave', 'q', { dump: false, deps: { fetchPage: async () => cloaked, canResolve: true } });
  assert.equal(row.status, 'drift');
  assert.match(row.detail, /none of 12 result links could be resolved/);
  const old = await checkEngine('brave', 'q', { dump: false, deps: { fetchPage: async () => cloaked, canResolve: false } });
  assert.match(old.detail, /0\.8\.0 or later/);
});

test('checkEngine: a CAPTCHA, a "no results" page and a dead extension are not drift', async () => {
  const captcha = { url: 'https://www.google.com/sorry/index?continue=x', title: '', html: '<html><body>unusual traffic</body></html>' };
  assert.equal((await checkEngine('google', 'q', { deps: { fetchPage: async () => captcha } })).status, 'blocked');
  const none = { url: 'https://www.bing.com/search?q=x', title: '', html: '<html><body><ol id="b_results"><li class="b_no">There are no results</li></ol></body></html>', textChars: 900 };
  assert.equal((await checkEngine('bing', 'q', { deps: { fetchPage: async () => none } })).status, 'empty');
  const dead = await checkEngine('duckduckgo', 'q', { deps: { fetchPage: async () => { throw new Error('Browser extension not connected'); } } });
  assert.equal(dead.status, 'unreachable');
  assert.match(dead.detail, /not connected/);
  assert.equal((await checkEngine('altavista', 'q')).status, 'unreachable');
});

test('checkEngines: every engine by default, in table order', async () => {
  const rows = await checkEngines({ pauseMs: 0, deps: { fetchPage: async (url) => load(Object.keys(ENGINES).find(id => url.startsWith(ENGINES[id].url('').split('?')[0]))).page } });
  assert.deepEqual(rows.map(r => `${r.engine}:${r.status}`), Object.keys(ENGINES).map(id => `${id}:ok`));
});
