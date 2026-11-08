import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeTree, capToolResult, trimLargeToolResults, fitToolResultsToContext, MAX_TOOL_RESULT_CHARS, MAX_TREE_FILES,
} from '../src/services/toolResultLimits.js';

test('summarizeTree returns a small tree whole and a large one as layout + head + how to see more', () => {
  const small = summarizeTree(['./a.js', './src/b.js'], { root: '/r' });
  assert.deepEqual(small, { root: '/r', fileCount: 2, files: ['a.js', 'src/b.js'] });
  const big = [...Array(5000)].map((_, i) => `./src/${i % 7}/f${i}.c`).concat(['./README.md', './CMakeLists.txt', ...[...Array(2000)].map((_, i) => `./tools/t${i}.cpp`)]);
  const out = summarizeTree(big, { root: '/r' });
  assert.equal(out.fileCount, 7002);
  assert.equal(out.truncated, true);
  assert.equal(out.files.length, MAX_TREE_FILES);
  assert.equal(out.layout[0], '<root> (2 files)');
  assert.ok(out.layout.includes('src/ (5000 files)') && out.layout.includes('tools/ (2000 files)'));
  assert.match(out.note, /7002 files — only the first 300 are listed.*"path".*grep/);
  assert.ok(JSON.stringify(out).length < 20000, 'a 7K-file tree is now a few KB');
  assert.equal(summarizeTree(['./x.c'], { root: '/r', subdir: 'src' }).path, 'src');
});

test('capToolResult passes short results through and caps a runaway one with its head', () => {
  assert.equal(capToolResult('{"ok":true}'), '{"ok":true}');
  const huge = JSON.stringify({ files: [...Array(20000)].map((_, i) => `path/to/file${i}.c`) });
  const capped = JSON.parse(capToolResult(huge));
  assert.equal(capped._truncated, true);
  assert.equal(capped.originalChars, huge.length);
  assert.ok(capped.head.length > MAX_TOOL_RESULT_CHARS * 0.6 && capped.head.length <= MAX_TOOL_RESULT_CHARS, `head ${capped.head.length}`);
  assert.equal(capped.keptChars, capped.head.length);
  assert.ok(JSON.stringify(capped).length <= MAX_TOOL_RESULT_CHARS + 400, 'the envelope itself respects the ceiling, quotes escaped and all');
  assert.equal(capToolResult('abc', 2).includes('"keptChars":2'), true);
});

const toolMsg = (n) => ({ role: 'user', content: `Tool "x" result: ${'y'.repeat(n)}` });

test('trimLargeToolResults cuts every oversized tool result, newest included, and nothing else', () => {
  const msgs = [{ role: 'system', content: 's'.repeat(5000) }, toolMsg(100), toolMsg(9000), { role: 'assistant', content: 'a'.repeat(5000) }, toolMsg(7000)];
  const freed = trimLargeToolResults(msgs, 1000);
  const prefix = 'Tool "x" result: '.length;
  assert.equal(freed, (9000 + prefix - 1000) + (7000 + prefix - 1000));
  assert.equal(msgs[0].content.length, 5000, 'system untouched');
  assert.equal(msgs[3].content.length, 5000, 'assistant untouched');
  assert.equal(msgs[1].content.length, 'Tool "x" result: '.length + 100, 'small result untouched');
  assert.match(msgs[2].content, /… \[8017 chars trimmed to fit the context\]$/);
});

test('fitToolResultsToContext shrinks until the counter says the prompt fits', async () => {
  const count = async (m) => Math.ceil(m.reduce((n, x) => n + x.content.length, 0) / 4);
  const msgs = [{ role: 'system', content: 's'.repeat(2000) }, toolMsg(50000), toolMsg(50000), toolMsg(400000)];
  const before = await count(msgs);
  assert.ok(before > 100000);
  const fit = await fitToolResultsToContext(msgs, { count, target: 10000, trimOld: (m) => 0 });
  assert.ok(fit.promptTokens <= 10000, `fits: ${fit.promptTokens}`);
  assert.ok(fit.passes >= 1 && fit.freed > 400000);
  // already fitting: no pass, nothing trimmed
  const small = [toolMsg(100)];
  const noop = await fitToolResultsToContext(small, { count, target: 10000 });
  assert.deepEqual([noop.passes, noop.freed], [0, 0]);
});
