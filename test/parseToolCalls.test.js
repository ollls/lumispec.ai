import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls } from '../src/tools/index.js';

// Shapes Qwen3.8 produced on 2026-10-29 (logs/routes_2026-10-29.jsonl): the opening quote of
// "arguments" dropped after a comma + newline, and the tool named under "function" instead of
// "name". Neither parsed, so the loop re-prompted the model 17 rounds in a row.

test('valid tool call parses unchanged', () => {
  const calls = parseToolCalls('<tool_call>\n{"name": "web_search", "arguments": {"query": "ok"}}\n</tool_call>');
  assert.deepEqual(calls, [{ name: 'web_search', arguments: { query: 'ok' } }]);
});

test('missing opening quote on the arguments key is repaired', () => {
  const calls = parseToolCalls('<tool_call>\n{"name": "web_search",\narguments": {"query": "site:reddit.com lumispec.ai"}}\n</tool_call>');
  assert.deepEqual(calls, [{ name: 'web_search', arguments: { query: 'site:reddit.com lumispec.ai' } }]);
});

test('"function" is accepted as the tool-name key', () => {
  const calls = parseToolCalls('<tool_call>\n{"function": "web_fetch",\narguments": {"url": "https://api.github.com/repos/ollls/lumispec.ai"}}\n</tool_call>');
  assert.deepEqual(calls, [{ name: 'web_fetch', arguments: { url: 'https://api.github.com/repos/ollls/lumispec.ai' } }]);
});

test('several malformed blocks in one response all parse', () => {
  const text = '<tool_call>\n{"name": "web_search",\narguments": {"query": "a"}}\n</tool_call>\n'
    + '<tool_call>\n{"function": "web_search",\narguments": {"query": "b"}\n}\n</tool_call>';
  assert.deepEqual(parseToolCalls(text).map(c => c.arguments.query), ['a', 'b']);
});

test('a string value containing a key-like fragment is not rewritten', () => {
  const code = 'd = {"x": 1}\nprint(d)';
  const calls = parseToolCalls(`<tool_call>\n${JSON.stringify({ name: 'run_python', arguments: { code } })}\n</tool_call>`);
  assert.deepEqual(calls, [{ name: 'run_python', arguments: { code } }]);
});
