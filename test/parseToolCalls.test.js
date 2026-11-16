import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, detectArgFixes } from '../src/tools/index.js';

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

// Output monitoring (2026-11-15): the optional second argument collects every patch the parser
// needed, so the route log can count silent repairs. Passing it must not change what is parsed.

test('fixes: a valid call reports nothing, even when a tolerant replacement touches it', () => {
  const fixes = [];
  parseToolCalls('<tool_call>\n{"name": "web_search", "arguments": {"query": "True Detective"}}\n</tool_call>', fixes);
  assert.deepEqual(fixes, []);
});

test('fixes: key repair, python literals and equals syntax are named', () => {
  const keys = [];
  parseToolCalls('<tool_call>\n{"function": "web_fetch",\narguments": {"url": "https://example.com"}}\n</tool_call>', keys);
  assert.deepEqual(keys, ['key-normalized']);

  const literals = [];
  parseToolCalls('<tool_call>\n{"name": "source_read", "arguments": {"action": "tree", "force": True}}\n</tool_call>', literals);
  assert.deepEqual(literals, ['python-literals']);

  const equals = [];
  parseToolCalls('<tool_call>\n{"name"= "web_search", "arguments"= {"query": "a"}}\n</tool_call>', equals);
  assert.deepEqual(equals, ['equals-syntax']);
});

test('fixes: raw newline in a string, unreadable block, empty block', () => {
  const newline = [];
  const calls = parseToolCalls('<tool_call>\n{"name": "run_python", "arguments": {"code": "a = 1\nprint(a)"}}\n</tool_call>', newline);
  assert.equal(calls.length, 1);
  assert.deepEqual(newline, ['repair-newlines']);

  const dead = [];
  assert.deepEqual(parseToolCalls('<tool_call>\nnot a call at all\n</tool_call>', dead), []);
  assert.deepEqual(dead, ['unparseable-block']);

  const empty = [];
  parseToolCalls('<tool_call></tool_call>', empty);
  assert.deepEqual(empty, ['empty-block']);
});

test('fixes: untagged and <invoke> calls are named, one entry per call', () => {
  const bare = [];
  parseToolCalls('{"name": "web_search", "arguments": {"query": "a"}}', bare);
  assert.deepEqual(bare, ['bare-json']);

  const invoke = [];
  parseToolCalls('<invoke name="web_search"><parameter name="query">a</parameter></invoke>', invoke);
  assert.deepEqual(invoke, ['invoke-syntax']);
});

test('fixes: the collector does not change the parse', () => {
  const text = '<tool_call>\n{"function": "web_fetch",\narguments": {"url": "x"}}\n</tool_call>';
  assert.deepEqual(parseToolCalls(text, []), parseToolCalls(text));
});

test('detectArgFixes names the run_python auto-fixes and ignores other tools', () => {
  assert.deepEqual(detectArgFixes([{ name: 'run_python', arguments: { code: 'x = 1\nprint(x)' } }]), []);
  assert.deepEqual(detectArgFixes([{ name: 'run_python', arguments: { code: 'ok = true' } }]), ['python-booleans']);
  assert.deepEqual(detectArgFixes([{ name: 'run_python', arguments: { code: 'print("a\\\nb")' } }]), ['escaped-newlines']);
  assert.deepEqual(detectArgFixes([{ name: 'web_search', arguments: { query: 'null true' } }]), []);
});
