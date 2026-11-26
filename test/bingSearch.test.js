// Bing engine: result parsing and the engine's own "no results" page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES } from '../src/tools/plugin-browser.js';

const wrap = (url) => `https://www.bing.com/ck/a?!&&p=abc&u=a1${Buffer.from(url).toString('base64url')}&ntb=1`;
const page = (items) => ({
  url: 'https://www.bing.com/search?q=x&setlang=en',
  html: `<html><body><ol id="b_results">${items}</ol></body></html>`,
});
const algo = (url, title, desc) =>
  `<li class="b_algo"><h2><a href="${wrap(url)}">${title}</a></h2><div class="b_caption"><p>${desc}</p></div></li>`;

test('bing parser unwraps /ck/ links', () => {
  const out = ENGINES.bing.parse(page(algo('https://example.com/a', 'A', 'first') + algo('https://example.org/b', 'B', 'second')), 8);
  assert.deepEqual(out.map(r => r.url), ['https://example.com/a', 'https://example.org/b']);
  assert.equal(out[0].description, 'first');
});

test('bing: its own "no results" page is recognized as empty', () => {
  const none = page('<li class="b_no"><h1>There are no results for <strong>x</strong></h1></li><li class="b_trendingSuggestion b_ans">Searches you might like</li>');
  assert.equal(ENGINES.bing.parse(none, 8).length, 0);
  assert.equal(ENGINES.bing.empty(none), true);
});

test('bing: a page with results, or with neither marker, is not "empty"', () => {
  assert.equal(ENGINES.bing.empty(page(algo('https://example.com/a', 'A', 'd'))), false);
  assert.equal(ENGINES.bing.empty(page('<li class="b_ans">something new</li>')), false); // parser drift → still dumped
});
