// Brave Search, 2026-11-22: every result link became a cloaked redirect (/go/v1#<encrypted
// token>) and the parser, which wanted http links, returned nothing for a page showing 20
// results. The extension (0.8.0+) now resolves those links in the browser and writes the
// destination on each as data-resolved-href; these tests cover the server half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, unresolvedLinksReason } from '../src/tools/plugin-browser.js';

// One result as Brave rendered it on 2026-11-23 (classes kept, favicon markup dropped).
const result = ({ token, resolved, site, title, desc }) => `
<div class="snippet svelte-jmfu5f" data-pos="0" data-type="web" data-keynav="true"><div class="result-body svelte-1rq4ngz">
<div class="result-wrapper svelte-1rq4ngz"><div class="result-content svelte-1rq4ngz">
<a href="/go/v1#${token}"${resolved ? ` data-resolved-href="${resolved}"` : ''} target="_self" class="svelte-14r20fy l1" data-sveltekit-reload="">
<div class="site-name-wrapper svelte-on1hvy"><div class="site-name-content svelte-on1hvy"><div class="desktop-small-semibold t-secondary text-ellipsis">${site}</div>
<cite class="snippet-url desktop-small-regular t-tertiary svelte-on1hvy">https://${site} <span class="text-ellipsis">› home</span></cite></div></div>
<div class="title search-snippet-title line-clamp-1 svelte-14r20fy">${title}</div></a>
<div class="generic-snippet svelte-1cwdgg3"><div class="content desktop-default-regular t-primary line-clamp-dynamic svelte-1cwdgg3"><span class="t-secondary">2 days ago -</span> ${desc}</div></div>
</div></div></div></div>`;

const page = (results) => ({
  url: 'https://search.brave.com/search?q=svelte+stores&source=web',
  html: `<html><body><main>${results.map(result).join('')}</main></body></html>`,
});

const ROWS = [
  { token: 'AAA1', resolved: 'https://svelte.dev/tutorial/svelte/stores', site: 'svelte.dev', title: 'Stores • Svelte Tutorial', desc: 'A store is an object that allows reactive access to a value.' },
  { token: 'AAA2', resolved: 'https://svelte.dev/docs/svelte/stores?x=1&amp;y=2', site: 'svelte.dev', title: 'Stores • Docs', desc: 'Reference for writable, readable and derived.' },
  { token: 'AAA3', site: 'unresolved.example', title: 'Never resolved', desc: 'The frame timed out.' },
  { token: 'AAA4', resolved: 'https://svelte.dev/tutorial/svelte/stores', site: 'svelte.dev', title: 'Duplicate address', desc: 'Same destination again.' },
  { token: 'AAA5', resolved: 'https://search.brave.com/help', site: 'brave.com', title: 'Brave own page', desc: 'Not a result.' },
];

test('Brave parser reads the resolved address of cloaked result links', () => {
  const out = ENGINES.brave.parse(page(ROWS), 8);
  assert.deepEqual(out.map(r => r.url), [
    'https://svelte.dev/tutorial/svelte/stores',
    'https://svelte.dev/docs/svelte/stores?x=1&y=2',
  ]);
  assert.equal(out[0].title, 'Stores • Svelte Tutorial');
  assert.equal(out[0].description, 'A store is an object that allows reactive access to a value.');
});

test('Brave parser returns nothing, not redirect links, when no link was resolved', () => {
  const out = ENGINES.brave.parse(page(ROWS.map(({ resolved, ...r }) => r)), 8);
  assert.deepEqual(out, []);
});

test('Brave parser still reads direct links (markup before 2026-11-22)', () => {
  const html = page([ROWS[0]]).html.replace('href="/go/v1#AAA1" data-resolved-href="https://svelte.dev/tutorial/svelte/stores"', 'href="https://old.example/page"');
  const out = ENGINES.brave.parse({ url: 'https://search.brave.com/search?q=x', html }, 8);
  assert.equal(out[0].url, 'https://old.example/page');
});

test('Brave asks the extension to resolve its result links', () => {
  assert.equal(typeof ENGINES.brave.resolveLinks.selector, 'string');
  assert.ok(ENGINES.brave.resolveLinks.limit >= 8);
});

test('unresolvedLinksReason names the cause of an empty result', () => {
  const brave = ENGINES.brave;
  assert.match(unresolvedLinksReason(brave, {}, false), /extension 0\.8\.0 or later/);
  assert.match(unresolvedLinksReason(brave, { links: { asked: 12, resolved: 0, ms: 5000 } }, true), /none of 12 result links/);
  assert.match(unresolvedLinksReason(brave, { links: { asked: 0, resolved: 0, ms: 0, error: 'bad selector' } }, true), /bad selector/);
  // Links resolved, or none found on the page: a selector problem, reported the usual way.
  assert.equal(unresolvedLinksReason(brave, { links: { asked: 12, resolved: 9, ms: 140 } }, true), null);
  assert.equal(unresolvedLinksReason(brave, { links: { asked: 0, resolved: 0, ms: 0 } }, true), null);
  assert.equal(unresolvedLinksReason(ENGINES.duckduckgo, {}, false), null);
});
