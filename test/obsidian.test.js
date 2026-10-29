// Unit + integration tests for the Obsidian exporter (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findVaults, resolveVault, renderNote, exportConversation, attachmentDir, noteRelPath, slugify } from '../src/services/obsidian.js';

const TZ = 'UTC';

function conv(over = {}) {
  return {
    id: 'f49d242b-e702-456e-b9f6-9d0a06ad7367',
    title: 'Tasks: fetch sites, select top news worthy attention',
    pinned: true,
    session: 'amber',
    tokenCount: 41230,
    createdAt: '2026-10-25T12:40:11.000Z',
    updatedAt: '2026-10-25T13:05:52.000Z',
    messages: [],
    ...over,
  };
}

// ── renderNote ──────────────────────────────────────

test('slug and note path', () => {
  assert.equal(slugify('Tasks: fetch sites, select top news worthy attention'), 'tasks-fetch-sites-select-top-news-worthy-attention');
  assert.equal(slugify('   '), 'untitled');
  assert.equal(noteRelPath(conv()), 'amber/tasks-fetch-sites-select-top-news-worthy-attention-f49d242b.md');
  assert.equal(noteRelPath(conv({ session: null })), 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b.md');
  assert.equal(noteRelPath(conv({ session: 'Bad Colour' })), 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b.md');
});

test('plain chat: frontmatter, headings, hidden session prompt skipped', () => {
  const c = conv({
    messages: [
      { role: 'user', content: 'You are the amber session. Be brief.', sentAt: '2026-10-25T12:40:11.000Z', hidden: true },
      { role: 'assistant', content: { text: 'Ready.', reasoning: 'init' }, sentAt: '2026-10-25T12:40:12.000Z' },
      { role: 'user', content: 'What is Monero?', sentAt: '2026-10-25T12:50:05.000Z' },
      { role: 'assistant', content: { text: '**Monero (XMR)** is a privacy coin.', reasoning: 'thinking about monero' }, sentAt: '2026-10-25T12:50:30.000Z' },
    ],
  });
  const { markdown, sidecars } = renderNote(c, { timeZone: TZ, model: 'Qwen3.8-27B' });
  assert.equal(sidecars.length, 0);
  assert.match(markdown, /^---\ntitle: "Tasks: fetch sites, select top news worthy attention"\nlumispec_id: "f49d242b-e702-456e-b9f6-9d0a06ad7367"\n/);
  assert.match(markdown, /\nsession: "amber"\npinned: true\nmodel: "Qwen3.8-27B"\nmessages: 3\ntokens: 41230\ntools_used: \[\]\ntags: \["lumispec", "lumispec\/amber"\]\n---\n/);
  assert.ok(!markdown.includes('You are the amber session'), 'hidden session prompt must not be exported');
  assert.ok(markdown.includes('## 🧑 2026-10-25 12:50\n\nWhat is Monero?'));
  assert.ok(markdown.includes('## 🤖 2026-10-25 12:50\n\n**Monero (XMR)** is a privacy coin.'));
  assert.ok(!markdown.includes('[!note]- Thinking'), 'reasoning off by default');
  assert.ok(markdown.endsWith('Exported from Lumispec · 2026-10-25T13:05:52.000Z\n'));
  assert.ok(!/localhost|http:\/\//.test(markdown), 'no link back into the app');
});

test('reasoning toggle adds a folded callout retroactively', () => {
  const c = conv({ messages: [{ role: 'assistant', content: { text: 'A', reasoning: 'line one\n\nline two' }, sentAt: '2026-10-25T12:50:30.000Z' }] });
  const { markdown } = renderNote(c, { timeZone: TZ, includeReasoning: true });
  assert.ok(markdown.includes('> [!note]- Thinking\n> line one\n>\n> line two\n\nA'));
});

test('tool calls: markdown results, auto-saved files, raw json, errors, toggle off', () => {
  const toolUses = [
    { name: 'web_search', result: JSON.stringify({ query: 'AMD news', results: [{ title: 'x', url: 'https://a' }], _markdown: '| t | u |\n|---|---|\n| x | a |' }) },
    { name: 'etrade_account', result: JSON.stringify({ _autoSaved: true, savedFile: { filename: 'optionchains_1.csv' }, _note: '120 rows saved' }) },
    { name: 'run_python', result: JSON.stringify({ stdout: 'ok', _images: ['zzz'] }) },
    { name: 'web_fetch', result: JSON.stringify({ url: 'https://b', error: 'HTTP 403' }) },
  ];
  const c = conv({ messages: [{ role: 'assistant', content: { text: 'Done.', toolUses }, sentAt: '2026-10-25T12:50:30.000Z' }] });
  const { markdown } = renderNote(c, { timeZone: TZ, availableFiles: new Set(['optionchains_1.csv']) });
  assert.ok(markdown.includes('> [!info]- 🔧 web_search — "AMD news"\n> | t | u |\n> |---|---|\n> | x | a |'));
  assert.ok(markdown.includes('> [!info]- 🔧 etrade_account\n> Result saved to [[optionchains_1.csv]]\n> 120 rows saved'));
  assert.ok(markdown.includes('> [!info]- 🔧 run_python\n> ```json\n> {\n>   "stdout": "ok"\n> }\n> ```'), 'underscore keys stripped from raw json');
  assert.ok(markdown.includes('> [!warning]- 🔧 web_fetch — "https://b"\n> HTTP 403'));
  assert.match(markdown, /tools_used: \["etrade_account", "run_python", "web_fetch", "web_search"\]/);
  const off = renderNote(c, { timeZone: TZ, includeTools: false }).markdown;
  assert.ok(!off.includes('[!info]'));
  assert.ok(off.includes('tools_used: ["etrade_account"'), 'frontmatter still lists tools when bodies are hidden');
});

test('long tool results are truncated with the original size', () => {
  const big = 'x'.repeat(5000);
  const c = conv({ messages: [{ role: 'assistant', content: { text: '', toolUses: [{ name: 't', result: big }] }, sentAt: '2026-10-25T12:50:30.000Z' }] });
  const { markdown } = renderNote(c, { timeZone: TZ });
  assert.ok(markdown.includes('x'.repeat(1500) + '\n> … (truncated, 5,000 chars)'));
  assert.ok(!markdown.includes('x'.repeat(1501)));
});

test('applets become html sidecars linked from callouts; file links become wikilinks', () => {
  const text = 'Chart below.\n\n<applet type="chartjs"><canvas id="c"></canvas><script>new Chart()</script></applet>\n\nData: [prices](/files/prices.csv) and [missing](/files/nope.csv).';
  const c = conv({ messages: [{ role: 'assistant', content: { text }, sentAt: '2026-10-25T12:50:30.000Z' }] });
  const { markdown, sidecars } = renderNote(c, { timeZone: TZ, availableFiles: ['prices.csv'] });
  assert.equal(sidecars.length, 1);
  assert.equal(sidecars[0].name, 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b-applet-1.html');
  assert.ok(sidecars[0].content.includes('chart.js'));
  assert.ok(sidecars[0].content.includes('<canvas id="c">'));
  assert.ok(markdown.includes('> [!example]- Applet (chartjs) — [[tasks-fetch-sites-select-top-news-worthy-attention-f49d242b-applet-1.html]]'));
  assert.ok(!markdown.includes('<applet'));
  assert.ok(markdown.includes('Data: [[prices.csv|prices]] and [missing](/files/nope.csv).'));
});

test('user images become attachments embedded with ![[ ]]', () => {
  const c = conv({ messages: [{ role: 'user', content: { text: 'what is this', images: [{ mimeType: 'image/png', base64: Buffer.from('png').toString('base64') }] }, sentAt: '2026-10-25T12:50:05.000Z' }] });
  const { markdown, sidecars } = renderNote(c, { timeZone: TZ });
  assert.equal(sidecars[0].kind, 'image');
  assert.ok(markdown.includes('what is this\n\n![[tasks-fetch-sites-select-top-news-worthy-attention-f49d242b-img-1.png]]'));
});

test('task pipeline run renders structured steps and subtasks, not the flattened text', () => {
  const taskRun = [
    { text: 'fetch AMD data', result: 'AMD closed at 150.', toolUses: [{ name: 'web_search', result: '{"query":"AMD"}' }], reasoning: 'r1' },
    { text: 'visualize', subtasks: [
      { text: 'chart prices', result: 'chart A', toolUses: [], reasoning: '' },
      { text: 'chart volume', result: '', error: 'Empty response after 2 tool call(s)' },
    ] },
  ];
  const c = conv({ messages: [{ role: 'assistant', content: { text: '### Task 1/2 FLAT TEXT', taskRun }, sentAt: '2026-10-25T12:50:30.000Z' }] });
  const { markdown } = renderNote(c, { timeZone: TZ });
  assert.ok(!markdown.includes('FLAT TEXT'));
  assert.ok(markdown.includes('## 🎯 Pipeline\n\n### Step 1 — fetch AMD data\n\n> [!info]- 🔧 web_search — "AMD"\n> ```json'));
  assert.ok(markdown.includes('AMD closed at 150.\n\n### Step 2 — visualize\n\n#### Subtask 2.1 — chart prices\n\nchart A\n\n#### Subtask 2.2 — chart volume\n\n> [!failure] Step failed\n> Empty response after 2 tool call(s)'));
  assert.match(markdown, /tools_used: \["web_search"\]/);
});

test('compacted conversation (string content) renders as the note body', () => {
  const c = conv({ messages: [{ role: 'assistant', content: '## Summary\n- decided X', sentAt: '2026-10-25T12:50:30.000Z' }] });
  const { markdown } = renderNote(c, { timeZone: TZ });
  assert.ok(markdown.includes('## 🤖 2026-10-25 12:50\n\n## Summary\n- decided X'));
});

// ── registries ──────────────────────────────────────

test('findVaults merges registries, open first then most recent, skips missing/malformed', () => {
  const files = {
    '/h/.config/obsidian/obsidian.json': JSON.stringify({ vaults: { a: { path: '/v/one', ts: 100, open: true } } }),
    '/h/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json': JSON.stringify({ vaults: { b: { path: '/v/one', ts: 50 }, c: { path: '/v/two', ts: 500 }, d: { path: '', ts: 1 } } }),
    '/h/snap/obsidian/current/.config/obsidian/obsidian.json': '{ not json',
  };
  const regs = [
    { kind: 'native', path: '/h/.config/obsidian/obsidian.json' },
    { kind: 'flatpak', path: '/h/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json' },
    { kind: 'snap', path: '/h/snap/obsidian/current/.config/obsidian/obsidian.json' },
    { kind: 'missing', path: '/h/nowhere.json' },
  ];
  const read = p => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
  const vaults = findVaults({ registries: regs, readText: read });
  assert.deepEqual(vaults.map(v => [v.path, v.open, v.ts]), [['/v/one', true, 100], ['/v/two', false, 500]]);
  assert.deepEqual(findVaults({ registries: regs, readText: () => { throw new Error('ENOENT'); } }), []);
});

test('resolveVault precedence: env > card > open > recent; null when nothing exists', () => {
  const vaults = [{ path: '/v/open', open: true, ts: 1 }, { path: '/v/recent', open: false, ts: 9 }];
  const dirs = new Set(['/v/open', '/v/recent', '/v/card', '/v/env']);
  const isDir = p => dirs.has(p);
  assert.deepEqual(resolveVault({ vault: '/v/card' }, { envVault: '/v/env', vaults, isDir }), { path: '/v/env', source: 'env' });
  assert.deepEqual(resolveVault({ vault: '/v/card' }, { envVault: '', vaults, isDir }), { path: '/v/card', source: 'card' });
  assert.deepEqual(resolveVault({}, { envVault: '', vaults, isDir }), { path: '/v/open', source: 'registry-open' });
  assert.deepEqual(resolveVault({}, { envVault: '', vaults: [vaults[1]], isDir }), { path: '/v/recent', source: 'registry-recent' });
  assert.equal(resolveVault({}, { envVault: '', vaults: [], isDir }), null, 'no Obsidian installed');
  assert.equal(resolveVault({ vault: '/v/gone' }, { envVault: '', vaults, isDir }), null, 'card points at a deleted folder');
  assert.equal(resolveVault({}, { envVault: '/v/gone', vaults, isDir }), null, 'env points at a missing folder');
});

test('attachmentDir honours the vault setting', () => {
  const read = (val) => () => JSON.stringify({ attachmentFolderPath: val });
  const none = () => { throw new Error('ENOENT'); };
  assert.equal(attachmentDir('/v', 'Lumispec', '/v/Lumispec/amber', { readText: none }), '/v/Lumispec/attachments');
  assert.equal(attachmentDir('/v', 'Lumispec', '/v/Lumispec/amber', { readText: read('') }), '/v/Lumispec/attachments');
  assert.equal(attachmentDir('/v', 'Lumispec', '/v/Lumispec/amber', { readText: read('./attachments') }), '/v/Lumispec/amber/attachments');
  assert.equal(attachmentDir('/v', 'Lumispec', '/v/Lumispec/amber', { readText: read('./') }), '/v/Lumispec/amber');
  assert.equal(attachmentDir('/v', 'Lumispec', '/v/Lumispec/amber', { readText: read('Files/att') }), '/v/Files/att');
  assert.equal(attachmentDir('/v', 'Lumispec', '/v/Lumispec/amber', { readText: read('/') }), '/v');
});

// ── integration against a temp vault ───────────────

test('exportConversation: paths, atomic write, idempotence, attachments, move on colour change', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumispec-obsidian-'));
  try {
    const vault = join(root, 'vault');
    const sourceDir = join(root, 'src');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(vault, '.obsidian', 'app.json'), JSON.stringify({ attachmentFolderPath: 'Files' }));
    writeFileSync(join(sourceDir, 'prices.csv'), 'a,b\n1,2\n');

    const text = 'See [prices](/files/prices.csv).\n\n<applet type="svg"><svg></svg></applet>';
    const c = conv({ messages: [{ role: 'assistant', content: { text }, sentAt: '2026-10-25T12:50:30.000Z' }] });
    const cfg = { folder: 'Lumispec', includeTools: true };
    const v = { path: vault, source: 'env' };

    const r1 = exportConversation(c, cfg, { vault: v, sourceDir, model: 'm' });
    const expected = join(vault, 'Lumispec', 'amber', 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b.md');
    assert.equal(r1.path, expected);
    assert.ok(existsSync(expected));
    assert.ok(!existsSync(expected + '.tmp'), 'temp file renamed away');
    assert.ok(existsSync(join(vault, 'Files', 'prices.csv')), 'data file copied to the vault attachment folder');
    assert.ok(existsSync(join(vault, 'Files', 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b-applet-1.html')));
    const md1 = readFileSync(expected, 'utf-8');
    assert.ok(md1.includes('[[prices.csv|prices]]'));

    const r2 = exportConversation(c, cfg, { vault: v, sourceDir, model: 'm' });
    assert.equal(readFileSync(r2.path, 'utf-8'), md1, 'second export is byte-identical');

    // Colour change moves the note; nothing is deleted
    const r3 = exportConversation({ ...c, session: 'blue' }, cfg, { vault: v, sourceDir, model: 'm' });
    assert.equal(r3.moved, expected);
    assert.ok(!existsSync(expected));
    assert.ok(existsSync(join(vault, 'Lumispec', 'blue', 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b.md')));
    assert.ok(statSync(join(vault, 'Lumispec', 'amber')).isDirectory(), 'old folder left in place');

    // Title change renames the note in place (same id suffix), no duplicate left behind
    const r4 = exportConversation({ ...c, session: 'blue', title: 'Renamed' }, cfg, { vault: v, sourceDir, model: 'm' });
    assert.equal(r4.path, join(vault, 'Lumispec', 'blue', 'renamed-f49d242b.md'));
    assert.equal(r4.moved, join(vault, 'Lumispec', 'blue', 'tasks-fetch-sites-select-top-news-worthy-attention-f49d242b.md'));
    assert.ok(!existsSync(r4.moved));
    assert.ok(existsSync(r4.path));

    // Path escape guard
    assert.throws(() => exportConversation(c, { folder: '../outside' }, { vault: v, sourceDir }), /outside the vault/);
    // No vault: a card path that does not exist resolves to null (never falls back to the real registry here)
    assert.throws(() => exportConversation(c, { vault: join(root, 'missing') }, { sourceDir, envVault: '' }), /no vault configured/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
