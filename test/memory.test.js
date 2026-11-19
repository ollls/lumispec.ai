import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  slugify, resolveColorArg, visibleMemories, indexLine, renderMemorySection, resolveMemory,
  listMemories, saveMemory, removeMemory, INLINE_CHARS, MAX_TEXT_CHARS,
  fitIndex, clampIndexChars, MAX_INDEX_CHARS, MIN_INDEX_CHARS, MAX_INDEX_CHARS_LIMIT,
} from '../src/services/memory.js';
import { runMemoryTool } from '../src/tools/plugin-memory.js';
import { getSystemPrompt } from '../src/tools/index.js';

// Memories: one file per fact in a temp directory; no llama, no server.

const root = () => mkdtemp(join(tmpdir(), 'memory-test-'));
const at = (s) => new Date(s);

test('save writes one editable file and list reads it back', async () => {
  const dir = await root();
  const { memory, existed } = saveMemory({ name: 'Home city', text: 'Lives in Denver.' }, dir, at('2026-11-14T10:00:00Z'));
  assert.equal(existed, false);
  assert.equal(memory.id, 'home-city');
  const raw = await readFile(join(dir, 'home-city.md'), 'utf-8');
  assert.match(raw, /^---\nname: Home city\ncreated: 2026-11-14T10:00:00.000Z\nupdated: 2026-11-14T10:00:00.000Z\n---\n\nLives in Denver\.\n$/);
  assert.deepEqual(listMemories(dir).map(m => [m.name, m.text, m.color]), [['Home city', 'Lives in Denver.', null]]);
  assert.deepEqual((await readdir(dir)).sort(), ['home-city.md']); // no .tmp left behind
});

test('saving under the same name replaces the text and keeps created and color', async () => {
  const dir = await root();
  saveMemory({ name: 'Home city', text: 'Lives in Austin.', color: 'amber' }, dir, at('2026-01-01T00:00:00Z'));
  const { memory, existed, previous } = saveMemory({ name: 'home  city', text: 'Lives in Denver.' }, dir, at('2026-11-14T00:00:00Z'));
  assert.equal(existed, true);
  assert.equal(previous.text, 'Lives in Austin.');
  assert.equal(memory.created, '2026-01-01T00:00:00.000Z');
  assert.equal(memory.updated, '2026-11-14T00:00:00.000Z');
  assert.equal(memory.color, 'amber');
  assert.equal(listMemories(dir).length, 1);
  // color: null clears the tag
  assert.equal(saveMemory({ name: 'Home city', text: 'Lives in Denver.', color: null }, dir).memory.color, null);
});

test('save rejects empty, oversized and badly colored memories', async () => {
  const dir = await root();
  assert.throws(() => saveMemory({ name: '', text: 'x' }, dir), /name/);
  assert.throws(() => saveMemory({ name: 'A', text: '  ' }, dir), /text/);
  assert.throws(() => saveMemory({ name: 'A', text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, dir), /up to/);
  assert.throws(() => saveMemory({ name: 'A', text: 'x', color: 'Not A Color' }, dir), /color/);
  assert.equal(listMemories(dir).length, 0);
});

test('a hand-written file without frontmatter is a memory; empty and hidden files are not', async () => {
  const dir = await root();
  await writeFile(join(dir, 'coffee-order.md'), 'Flat white, oat milk.\n');
  await writeFile(join(dir, 'empty.md'), '\n');
  await writeFile(join(dir, '.hidden.md'), 'no');
  await writeFile(join(dir, 'notes.txt'), 'no');
  assert.deepEqual(listMemories(dir).map(m => [m.id, m.name, m.text]), [['coffee-order', 'coffee order', 'Flat white, oat milk.']]);
});

test('list is oldest first, so a new memory is appended', async () => {
  const dir = await root();
  saveMemory({ name: 'Zebra', text: 'z' }, dir, at('2026-01-01T00:00:00Z'));
  saveMemory({ name: 'Apple', text: 'a' }, dir, at('2026-02-01T00:00:00Z'));
  saveMemory({ name: 'Zebra', text: 'z2' }, dir, at('2026-03-01T00:00:00Z')); // an update does not reorder
  assert.deepEqual(listMemories(dir).map(m => m.name), ['Zebra', 'Apple']);
});

test('resolveColorArg: omitted keeps, none clears, current needs a chat color', () => {
  assert.deepEqual(resolveColorArg(undefined, 'amber'), { color: undefined });
  assert.deepEqual(resolveColorArg('', 'amber'), { color: undefined });
  assert.deepEqual(resolveColorArg('none', 'amber'), { color: null });
  assert.deepEqual(resolveColorArg('current', 'amber'), { color: 'amber' });
  assert.match(resolveColorArg('current', null).error, /no session color/);
  assert.deepEqual(resolveColorArg('Sky', null), { color: 'sky' });
  assert.match(resolveColorArg('dark blue', null).error, /not a session color/);
});

test('color match: off shows everything, on hides other colors but never untagged memories', () => {
  const list = [{ name: 'g', color: null }, { name: 'a', color: 'amber' }, { name: 'b', color: 'blue' }];
  const names = (o) => visibleMemories(list, o).map(m => m.name);
  assert.deepEqual(names({ session: 'blue', colorMatch: false }), ['g', 'a', 'b']);
  assert.deepEqual(names({ session: 'blue', colorMatch: true }), ['g', 'b']);
  assert.deepEqual(names({ session: null, colorMatch: true }), ['g']);
});

test('index line: short memories in full, long ones by description', () => {
  assert.equal(indexLine({ name: 'Units', text: 'Prefers\nmetric units.' }), '- Units: Prefers metric units.');
  const long = 'x'.repeat(INLINE_CHARS + 1);
  assert.equal(indexLine({ name: 'Plan', text: long, description: 'Retirement plan rules' }), '- Plan: Retirement plan rules (long — read it for the full text)');
  assert.match(indexLine({ name: 'Plan', text: long }), /^- Plan: x{120}… \(long/);
});

test('prompt section lists visible memories and caps the list', () => {
  const empty = renderMemorySection([]);
  assert.match(empty, /^## Memories\n/);
  assert.match(empty, /\(none saved yet\)$/);
  const some = renderMemorySection([{ name: 'A', text: 'one', color: null }, { name: 'B', text: 'two', color: 'amber' }], { session: 'blue', colorMatch: true });
  assert.match(some, /\n- A: one$/);
  assert.doesNotMatch(some, /- B:/);
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `M${i}`, text: 'y'.repeat(150), color: null }));
  const capped = renderMemorySection(many);
  assert.match(capped, /\n- \(\d+ more not listed here — memory \{"action":"list"\} shows all\)$/);
  assert.ok(capped.length < 10000);
});

test('resolveMemory: exact name, single fragment, ambiguous fragment asks', () => {
  const list = [{ id: 'home-city', name: 'Home city' }, { id: 'home-wifi', name: 'Home wifi' }, { id: 'units', name: 'Units' }];
  assert.equal(resolveMemory('home city', list).memory.id, 'home-city');
  assert.equal(resolveMemory('wifi', list).memory.id, 'home-wifi');
  assert.deepEqual(resolveMemory('home', list).candidates, ['Home city', 'Home wifi']);
  assert.match(resolveMemory('boat', list).error, /No memory matches/);
  assert.match(resolveMemory('', list).error, /No memory was named/);
});

test('tool: save and forget need approval, even with autorun; color only when asked', async () => {
  const dir = await root();
  const asked = [];
  const ctx = (answer, extra = {}) => ({ autorun: true, confirmFn: async (t) => { asked.push(t); return answer; }, ...extra });

  assert.match((await runMemoryTool({ action: 'save', name: 'Units', text: 'Metric.' }, { autorun: true }, dir)).error, /approval/);
  assert.match((await runMemoryTool({ action: 'save', name: 'Units', text: 'Metric.' }, ctx(false), dir)).error, /declined/);
  assert.equal(listMemories(dir).length, 0);

  const saved = await runMemoryTool({ action: 'save', name: 'Units', text: 'Metric.' }, ctx(true, { session: 'amber' }), dir);
  assert.deepEqual([saved.saved, saved.updated, saved.color], [true, false, null]); // chat color is NOT applied by itself
  assert.match(asked.at(-1), /^Save memory "Units":\nMetric\.$/);

  const tagged = await runMemoryTool({ action: 'save', name: 'CHPY rule', text: 'No covered calls.', color: 'current' }, ctx(true, { session: 'amber' }), dir);
  assert.equal(tagged.color, 'amber');
  assert.match(asked.at(-1), /only for amber chats/);
  assert.match((await runMemoryTool({ action: 'save', name: 'X', text: 'y', color: 'current' }, ctx(true), dir)).error, /no session color/);

  const updated = await runMemoryTool({ action: 'save', name: 'units', text: 'Imperial.' }, ctx(true), dir);
  assert.equal(updated.updated, true);
  assert.match(asked.at(-1), /^Update memory "units":\nImperial\.\n\n\(replaces: Metric\.\)$/);

  const listed = await runMemoryTool({ action: 'list' }, {}, dir);
  assert.equal(listed.count, 2);
  assert.match(listed._markdown, /\| CHPY rule \| amber \|/);
  await runMemoryTool({ action: 'save', name: 'Plain', text: 'No color.' }, ctx(true), dir);
  const again = await runMemoryTool({ action: 'list' }, {}, dir);
  assert.match(again._markdown, /\| Plain \| N\/A \|/);
  assert.equal(again.memories.find(m => m.name === 'Plain').color, 'N/A');
  await runMemoryTool({ action: 'forget', name: 'Plain' }, ctx(true), dir);
  assert.equal((await runMemoryTool({ action: 'read', name: 'chpy' }, {}, dir)).text, 'No covered calls.');

  assert.match((await runMemoryTool({ action: 'forget', name: 'units' }, ctx(false), dir)).error, /declined/);
  assert.equal(listMemories(dir).length, 2);
  assert.equal((await runMemoryTool({ action: 'forget', name: 'units' }, ctx(true), dir)).forgotten, true);
  assert.deepEqual(listMemories(dir).map(m => m.name), ['CHPY rule']);
  removeMemory('chpy-rule', dir);
  assert.equal(listMemories(dir).length, 0);
});

test('system prompt is unchanged while no promptTail plugin is registered', () => {
  // Plugins are not loaded in this process, so no group contributes a tail.
  const p = getSystemPrompt({ session: 'amber' });
  assert.doesNotMatch(p, /## Memories/);
  assert.equal(p, getSystemPrompt());
  assert.equal(slugify('  Home   City! '), 'home-city');
});

test('list size: clamped, and fitIndex reports what the assistant does not see', () => {
  assert.equal(clampIndexChars(undefined), MAX_INDEX_CHARS);
  assert.equal(clampIndexChars('abc'), MAX_INDEX_CHARS);
  assert.equal(clampIndexChars(10), MIN_INDEX_CHARS);
  assert.equal(clampIndexChars(1e9), MAX_INDEX_CHARS_LIMIT);
  assert.equal(clampIndexChars('12000'), 12000);

  // 100 memories of ~157 chars per line: 8,000 holds 50, 20,000 holds all
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `M${String(i).padStart(3, '0')}`, text: 'y'.repeat(150), color: null }));
  const small = fitIndex(many, 8000);
  assert.equal(small.listed + small.hidden, 100);
  assert.ok(small.hidden > 0 && small.chars <= 8000);
  assert.equal(small.lines[0], `- M000: ${'y'.repeat(150)}`); // the oldest stay, the newest drop
  const big = fitIndex(many, 20000);
  assert.deepEqual([big.listed, big.hidden], [100, 0]);

  const prompt = renderMemorySection(many, { maxChars: 8000 });
  assert.match(prompt, new RegExp(`\\n- \\(${small.hidden} more not listed here`));
  assert.doesNotMatch(renderMemorySection(many, { maxChars: 20000 }), /more not listed here/);
  assert.match(renderMemorySection(many), new RegExp(`\\(${small.hidden} more`)); // default = 8,000
});
