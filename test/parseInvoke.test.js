import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, capToolCalls, droppedCallsNote } from '../src/tools/index.js';

// Claude on the Anthropic backend (2026-11-04 16:39Z, logs/routes_2026-11-04.jsonl) wrote its
// native tool-use syntax instead of the <tool_call> JSON the prompt asks for, followed by an
// empty <tool_call> block. The parser found nothing and the loop burned a repair round.

const CODE = 'amd=481.46; sh=400\nfor e in [0,-10]:\n    print(f"{e}%")';

test('an <invoke> block parses as a tool call, code kept verbatim', () => {
  const text = `\n<invoke name="run_python">\n<parameter name="code">${CODE}</parameter>\n</invoke>\n<tool_call>\n</tool_call>`;
  assert.deepEqual(parseToolCalls(text), [{ name: 'run_python', arguments: { code: CODE } }]);
});

test('several <invoke> blocks and several parameters', () => {
  const text = '<invoke name="web_fetch"><parameter name="url">https://a.example</parameter><parameter name="view">text</parameter></invoke>'
    + '<invoke name="web_search"><parameter name="query">b</parameter></invoke>';
  assert.deepEqual(parseToolCalls(text), [
    { name: 'web_fetch', arguments: { url: 'https://a.example', view: 'text' } },
    { name: 'web_search', arguments: { query: 'b' } },
  ]);
});

test('undeclared parameters: JSON objects parse, plain text stays text', () => {
  const text = '<invoke name="no_such_tool"><parameter name="opts">{"a": 1}</parameter><parameter name="s">hello</parameter></invoke>';
  assert.deepEqual(parseToolCalls(text), [{ name: 'no_such_tool', arguments: { opts: { a: 1 }, s: 'hello' } }]);
});

test('<tool_call> JSON and <invoke> blocks in one response both parse', () => {
  const text = '<tool_call>\n{"name": "web_search", "arguments": {"query": "a"}}\n</tool_call>\n'
    + '<invoke name="web_search"><parameter name="query">b</parameter></invoke>';
  assert.deepEqual(parseToolCalls(text).map(c => c.arguments.query), ['a', 'b']);
});

test('an empty <tool_call> block alone yields nothing', () => {
  assert.deepEqual(parseToolCalls('<tool_call>\n</tool_call>'), []);
});

test('capToolCalls collapses duplicates and names what it drops', () => {
  const call = (name, q) => ({ name, arguments: { q } });
  const calls = [call('a', 1), call('a', 1), call('b', 2), call('c', 3), call('d', 4), call('e', 5), call('f', 6)];
  const { kept, dropped } = capToolCalls(calls, 4);
  assert.deepEqual(kept.map(c => c.name), ['a', 'b', 'c', 'd']);
  assert.deepEqual(dropped.map(c => c.name), ['e', 'f']);
  const note = droppedCallsNote(dropped, 4);
  assert.match(note, /2 tool call\(s\) were NOT executed/);
  assert.match(note, /e\(\{"q":5\}\); f\(\{"q":6\}\)/);
  assert.equal(droppedCallsNote([], 4), '');
});

test('capToolCalls under the limit keeps order and drops nothing', () => {
  const calls = [{ name: 'a', arguments: {} }, { name: 'b', arguments: {} }];
  assert.deepEqual(capToolCalls(calls, 4), { kept: calls, dropped: [] });
});
