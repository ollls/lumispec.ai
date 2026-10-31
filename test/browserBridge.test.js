// Integration test for the extension bridge: a real WebSocket server with a fake extension on
// the other end, exercising the request/response pairing for fetch, tabs and read
// (docs/TAB_FETCH.md, steps 1-2). No Chrome involved.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import config from '../src/config.js';
import bridge from '../src/services/browserBridge.js';

const PAGE = { title: 'Inbox (3) - Mail', url: 'https://mail.example.com/u/0/#inbox', html: '<html><body><table><tr><td>A</td></tr></table></body></html>', text: 'A', textChars: 1, domChars: 1, wall: false, truncated: false, reads: 1 };
const TABS = [
  { id: 11, windowId: 1, active: true, current: true, title: 'Inbox (3) - Mail', url: 'https://mail.example.com/u/0/#inbox', lastAccessed: 1760000000000, discarded: false },
  { id: 12, windowId: 1, active: false, current: false, title: 'Chase - Accounts', url: 'https://secure.chase.com/web/auth/dashboard', lastAccessed: 1760000001000, discarded: false },
];

let server, ext, received = [];
const url = () => {
  const { port } = server.address();
  const token = config.browserSearch.token ? `?token=${encodeURIComponent(config.browserSearch.token)}` : '';
  return `ws://127.0.0.1:${port}/ws/browser${token}`;
};
const connectFakeExtension = (capabilities) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url());
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'hello', version: '0.7.0', capabilities, ua: 'test' }));
    // hello is processed on the server before the next message; give the event loop a tick
    setTimeout(() => resolve(ws), 20);
  });
  ws.on('error', reject);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    received.push(msg);
    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
    if (msg.type === 'fetch') {
      if (Number.isFinite(msg.reuseTabId)) return ws.send(JSON.stringify({ type: 'result', id: msg.id, page: PAGE, ms: 5, tab: TABS[0], reused: true }));
      const reply = { type: 'result', id: msg.id, page: PAGE, ms: 7 };
      if (msg.openTabs === true) reply.openTabs = TABS.filter(t => new URL(t.url).hostname === new URL(msg.url).hostname);
      return ws.send(JSON.stringify(reply));
    }
    if (msg.type === 'tabs') return ws.send(JSON.stringify({ type: 'result', id: msg.id, tabs: TABS }));
    if (msg.type === 'read') {
      if (msg.tabId === 99) return ws.send(JSON.stringify({ type: 'error', id: msg.id, message: 'tab closed' }));
      return ws.send(JSON.stringify({ type: 'result', id: msg.id, page: PAGE, tab: TABS.find(t => t.id === msg.tabId) || null, ms: 3 }));
    }
  });
});

test('bridge: setup', async () => {
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  bridge.attach(server);
});

test('tabs/read reject until the extension advertises the capabilities', async () => {
  ext = await connectFakeExtension(['fetch']);
  assert.equal(bridge.connected, true);
  assert.equal(bridge.hasCapability('fetch'), true);
  assert.equal(bridge.hasCapability('tabs'), false);
  await assert.rejects(bridge.listTabs(), /predates Tab Fetch/);
  await assert.rejects(bridge.readTab(11), /predates Tab Fetch/);
  // a plain fetch still works and carries no tab fields
  const page = await bridge.fetchPage('https://news.example.com/');
  assert.equal(page.title, PAGE.title);
  assert.equal(page.openTabs, undefined);
  assert.equal(page.reused, undefined);
  ext.close();
  await new Promise(r => setTimeout(r, 30));
});

test('listTabs, readTab, openTabs and reuseTabId round-trip with a 0.7.0 extension', async () => {
  received = [];
  ext = await connectFakeExtension(['fetch', 'tabs', 'read']);
  assert.equal(bridge.hasCapability('read'), true);

  const tabs = await bridge.listTabs();
  assert.equal(tabs.length, 2);
  assert.equal(tabs.find(t => t.current).id, 11);

  const read = await bridge.readTab(12);
  assert.equal(read.tab.title, 'Chase - Accounts');
  assert.equal(read.html, PAGE.html);
  assert.equal(read.ms, 3);
  await assert.rejects(bridge.readTab(99), /tab closed/);

  const withTabs = await bridge.fetchPage('https://mail.example.com/u/0/#search/x', { openTabs: true });
  assert.deepEqual(withTabs.openTabs.map(t => t.id), [11]);
  assert.equal(withTabs.reused, undefined);

  const reused = await bridge.fetchPage('https://mail.example.com/u/0/#inbox', { reuseTabId: 11 });
  assert.equal(reused.reused, true);
  assert.equal(reused.tab.id, 11);

  // the server sent exactly the message types the protocol defines
  assert.deepEqual([...new Set(received.map(m => m.type))].sort(), ['fetch', 'read', 'tabs']);
  const reuseMsg = received.find(m => m.type === 'fetch' && m.reuseTabId === 11);
  assert.ok(reuseMsg, 'reuseTabId is passed through to the extension');
});

after(() => {
  try { ext?.close(); } catch {}
  bridge.close();
  server?.close();
});
