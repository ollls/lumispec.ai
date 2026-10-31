// Tab Fetch (docs/TAB_FETCH.md): resolution, host care and the read flow, with fake tabs and a
// fake bridge. No Chrome involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTab, normalizeUrlForReuse, isAppUrl, tabSummary, hostCarePlan, readUserTab } from '../src/tools/plugin-browser.js';

const PORT = 3000;
const TABS = [
  { id: 1, windowId: 1, active: true, current: true, title: 'LLM Workbench', url: `http://localhost:${PORT}/`, lastAccessed: 1760000000000 },
  { id: 2, windowId: 1, active: false, current: false, title: 'Chase - Accounts', url: 'https://secure.chase.com/web/auth/dashboard', lastAccessed: 1760000001000 },
  { id: 3, windowId: 1, active: false, current: false, title: 'Bank of America | Online Banking', url: 'https://secure.bankofamerica.com/myaccounts/', lastAccessed: 1760000002000 },
  { id: 4, windowId: 2, active: true, current: false, title: 'Inbox (12) - me@example.com - Mail', url: 'https://mail.example.com/mail/u/0/#inbox', lastAccessed: 1760000003000 },
  { id: 5, windowId: 2, active: false, current: false, title: 'Chase - Credit Card', url: 'https://secure.chase.com/web/auth/cards', lastAccessed: 1760000004000, discarded: true },
];
const o = { port: PORT };

test('isAppUrl recognises the app on localhost/127.0.0.1 at the configured port only', () => {
  assert.equal(isAppUrl(`http://localhost:${PORT}/`, PORT), true);
  assert.equal(isAppUrl(`http://127.0.0.1:${PORT}/?x=1`, PORT), true);
  assert.equal(isAppUrl('http://localhost:8080/', PORT), false);
  assert.equal(isAppUrl('https://secure.chase.com/', PORT), false);
  assert.equal(isAppUrl('chrome://extensions/', PORT), false);
});

test('resolveTab: "active" never returns the app itself and asks instead', () => {
  const r = resolveTab('active', TABS, o);
  assert.match(r.error, /Lumispec itself/);
  assert.ok(!r.candidates.some(t => t.id === 1));
  const tabs2 = TABS.map(t => ({ ...t, current: t.id === 4 }));
  assert.equal(resolveTab('active', tabs2, o).tab.id, 4);
  assert.equal(resolveTab('current', tabs2, o).tab.id, 4);
});

test('resolveTab: one match reads, zero or several ask (the two-bank case)', () => {
  assert.equal(resolveTab('bankofamerica.com', TABS, o).tab.id, 3);
  assert.equal(resolveTab('Bank of America', TABS, o).tab.id, 3);
  const bank = resolveTab('bank', TABS, o);          // matches BofA title/url only? "bank" is in bankofamerica → 1 match
  assert.equal(bank.tab?.id, 3);
  const chase = resolveTab('chase', TABS, o);        // two Chase tabs → ask
  assert.match(chase.error, /2 open tabs match/);
  assert.deepEqual(chase.candidates.map(t => t.id), [2, 5]);
  assert.equal(resolveTab('Chase - Credit', TABS, o).tab.id, 5);
  const none = resolveTab('fidelity', TABS, o);
  assert.match(none.error, /No open tab matches/);
  assert.ok(none.candidates.length > 0);
});

test('resolveTab: numeric ids, closed ids, empty spec', () => {
  assert.equal(resolveTab(4, TABS, o).tab.id, 4);
  assert.equal(resolveTab('4', TABS, o).tab.id, 4);
  assert.match(resolveTab(99, TABS, o).error, /closed or not readable/);
  assert.match(resolveTab('', TABS, o).error, /Which tab/);
  assert.match(resolveTab('active', [], o).error, /No readable web tabs/);
});

test('tabSummary trims long queries and converts lastAccessed', () => {
  const s = tabSummary({ id: 9, title: 'X', url: 'https://a.example.com/p?' + 'q=1&'.repeat(40), current: true, lastAccessed: 1760000000000 });
  assert.match(s.url, /query omitted/);
  assert.equal(s.host, 'a.example.com');
  assert.equal(s.lastAccessed, new Date(1760000000000).toISOString());
  assert.equal(tabSummary({ id: 1, title: '', url: 'https://x.example/' }).title, '(untitled)');
});

test('normalizeUrlForReuse: tracking params and www dropped, hash and meaningful query kept', () => {
  assert.equal(normalizeUrlForReuse('https://www.npr.org/sections/news/?utm_source=x&utm_medium=y'), 'https://npr.org/sections/news');
  assert.equal(normalizeUrlForReuse('https://mail.example.com/mail/u/0/#inbox'), 'https://mail.example.com/mail/u/0#inbox');
  assert.equal(normalizeUrlForReuse('https://a.example/s?b=2&a=1'), normalizeUrlForReuse('https://a.example/s/?a=1&b=2'));
  assert.notEqual(normalizeUrlForReuse('https://a.example/s?q=cats'), normalizeUrlForReuse('https://a.example/s?q=dogs'));
});

test('hostCarePlan: reuse exact address, hint on same host, stop when protected, nothing otherwise', () => {
  const cfg = { reuseOpenTab: true, protectOpenSites: false };
  assert.deepEqual(hostCarePlan('https://news.example.org/', TABS, cfg), {});
  const reuse = hostCarePlan('https://mail.example.com/mail/u/0/#inbox', TABS, cfg);
  assert.equal(reuse.reuseTabId, 4);
  const hint = hostCarePlan('https://mail.example.com/mail/u/0/#search/x', TABS, cfg);
  assert.equal(hint.reuseTabId, undefined);
  assert.deepEqual(hint.openTabs.map(t => t.id), [4]);
  assert.match(hint.hint, /offer to read that tab/i);
  // a discarded (suspended) tab is never reused, but is still reported
  const disc = hostCarePlan('https://secure.chase.com/web/auth/cards', TABS, cfg);
  assert.equal(disc.reuseTabId, undefined);
  assert.deepEqual(disc.openTabs.map(t => t.id), [2, 5]);
  const noReuse = hostCarePlan('https://mail.example.com/mail/u/0/#inbox', TABS, { reuseOpenTab: false, protectOpenSites: false });
  assert.equal(noReuse.reuseTabId, undefined);
  assert.ok(noReuse.openTabs);
  const stop = hostCarePlan('https://secure.chase.com/other', TABS, { reuseOpenTab: true, protectOpenSites: true });
  assert.equal(stop.stop, true);
  assert.match(stop.error, /Never open hidden tabs/);
  // the app's own tab never counts as "the user has this site open"
  assert.deepEqual(hostCarePlan(`http://localhost:${PORT}/api/x`, TABS, cfg), {});
});

// ── readUserTab with a fake bridge ──
const ROWS = Array.from({ length: 20 }, (_, i) => ({ s: `Sender ${i}`, j: `Subject line of message number ${i}`, t: `${(i % 12) + 1}:0${i % 10} AM` }));
const PAGE = {
  title: 'Inbox (12) - me@example.com - Mail', url: 'https://mail.example.com/mail/u/0/#inbox',
  html: '<html><body><table>' + ROWS.map(r => `<tr><td>${r.s}</td><td>${r.j}</td><td>${r.t}</td></tr>`).join('') + '</table></body></html>',
  text: ROWS.map(r => `${r.s}\t${r.j}\t${r.t}`).join('\n'),           // what innerText gives for a table: tabs between cells
  textSource: 'innerText', textChars: 1200, domChars: 1200, wall: false, truncated: false, reads: 1,
};
const fakeBridge = (over = {}) => ({
  connected: true,
  hasCapability: (c) => ['fetch', 'tabs', 'read'].includes(c),
  listTabs: async () => TABS.map(t => ({ ...t, current: t.id === 4 })),
  readTab: async (id) => ({ ...PAGE, ms: 3, tab: TABS.find(t => t.id === id) }),
  ...over,
});
const ON = { readTabs: true, confirmTabReads: true, reuseOpenTab: true, protectOpenSites: false };

test('readUserTab: off switch, missing capability, offline', async () => {
  const off = await readUserTab({ spec: 'active', view: 'text', context: {}, deps: { bridge: fakeBridge(), cfg: { ...ON, readTabs: false }, maxChars: 4000, port: PORT } });
  assert.match(off.error, /Let the assistant read my open tabs/);
  const old = await readUserTab({ spec: 'active', view: 'text', context: {}, deps: { bridge: fakeBridge({ hasCapability: (c) => c === 'fetch' }), cfg: ON, maxChars: 4000, port: PORT } });
  assert.match(old.error, /predates Tab Fetch/);
  const offline = await readUserTab({ spec: 'active', view: 'text', context: {}, deps: { bridge: fakeBridge({ connected: false }), cfg: ON, maxChars: 4000, offline: 'browser extension not connected', port: PORT } });
  assert.match(offline.error, /not connected/);
});

test('readUserTab: confirmation names the tab; a decline reads nothing; autorun does not bypass', async () => {
  const prompts = [];
  let reads = 0;
  const br = fakeBridge({ readTab: async (id) => { reads++; return { ...PAGE, ms: 3, tab: TABS.find(t => t.id === id) }; } });
  const declined = await readUserTab({ spec: 'mail.example.com', view: 'text', context: { autorun: true, confirmFn: async (p) => { prompts.push(p); return false; } }, deps: { bridge: br, cfg: ON, maxChars: 4000, port: PORT } });
  assert.equal(declined.declined, true);
  assert.equal(reads, 0);
  assert.match(prompts[0], /Read your open browser tab: "Inbox \(12\)/);
  assert.match(prompts[0], /mail\.example\.com/);
  const noChannel = await readUserTab({ spec: 'mail.example.com', view: 'text', context: {}, deps: { bridge: br, cfg: ON, maxChars: 4000, port: PORT } });
  assert.match(noChannel.error, /no confirmation channel/);
  assert.equal(reads, 0);
});

test('readUserTab: approved read returns on-screen text, marked as a tab read, never navigated', async () => {
  const r = await readUserTab({ spec: 'active', view: 'text', context: { confirmFn: async () => true }, deps: { bridge: fakeBridge(), cfg: ON, maxChars: 4000, port: PORT } });
  assert.equal(r.source, 'tab');
  assert.equal(r.tab.id, 4);
  assert.equal(r.view, 'text');
  assert.match(r._tier, /your open tab, read in place/);
  assert.match(r.content.split('\n')[0], /^Sender 0 · Subject line of message number 0 · 1:00 AM$/);
  assert.equal(r.content.split('\n').length, 20);
  assert.match(r.note, /Nothing was navigated, clicked or closed/);
});

test('readUserTab: with confirmation off no prompt is shown; ambiguity and closed tabs are reported', async () => {
  let asked = 0;
  const r = await readUserTab({ spec: 'bankofamerica.com', view: 'article', context: { confirmFn: async () => { asked++; return true; } }, deps: { bridge: fakeBridge(), cfg: { ...ON, confirmTabReads: false }, maxChars: 4000, port: PORT } });
  assert.equal(asked, 0);
  assert.equal(r.tab.id, 3);
  const amb = await readUserTab({ spec: 'chase', view: 'text', context: {}, deps: { bridge: fakeBridge(), cfg: { ...ON, confirmTabReads: false }, maxChars: 4000, port: PORT } });
  assert.match(amb.error, /2 open tabs match/);
  assert.equal(amb.tabs.length, 2);
  const closed = await readUserTab({ spec: 2, view: 'text', context: {}, deps: { bridge: fakeBridge({ readTab: async () => { throw new Error('tab closed'); } }), cfg: { ...ON, confirmTabReads: false }, maxChars: 4000, port: PORT } });
  assert.match(closed.error, /tab closed/);
});

test('readUserTab: a tab with no readable text is reported, not re-fetched', async () => {
  const blank = { ...PAGE, html: '<html><body></body></html>', text: '', textChars: 0, domChars: 0 };
  const r = await readUserTab({ spec: 4, view: 'text', context: {}, deps: { bridge: fakeBridge({ readTab: async () => ({ ...blank, ms: 1, tab: TABS[3] }) }), cfg: { ...ON, confirmTabReads: false }, maxChars: 4000, port: PORT } });
  assert.match(r.error, /no readable text/);
  assert.equal(r.source, 'tab');
});
