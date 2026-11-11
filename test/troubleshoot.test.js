import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { readConversationPart } from '../src/services/conversationRead.js';

// The Troubleshoot button on an assistant bubble: troubleshoot.js builds the prompt text from
// the stored turn. Loaded here the way the page loads it — a plain script on a bare global.
const SRC = readFileSync(new URL('../src/public/js/troubleshoot.js', import.meta.url), 'utf8');
function load() {
  const sandbox = { window: {} };
  vm.runInNewContext(SRC, sandbox);
  return sandbox.window.Troubleshoot;
}
const T = load();
const tu = (name, result) => ({ name, result: typeof result === 'string' ? result : JSON.stringify(result) });

test('report: a clean run says so, with tool counts in call order', () => {
  const lines = T.turnReport({
    text: 'NVDA is the better buy.',
    toolUses: [tu('etrade_account', { quote: 1 }), tu('web_search', { results: [] }), tu('etrade_account', { quote: 2 })],
  });
  assert.equal(lines[0], '3 tool call(s): etrade_account ×2, web_search');
  assert.ok(lines.includes('no tool errors, fallbacks or truncated results recorded'));
  assert.equal(lines.at(-1), 'answer: 23 chars');
});

test('report: errors, fallbacks, login walls and truncation are named with their index', () => {
  const lines = T.turnReport({
    text: 'x',
    toolUses: [
      tu('etrade_account', { ok: true }),
      tu('etrade_account', { error: 'transactions failed: API error: 401 nonce_used' }),
      tu('web_fetch', { fallback: 'extension timed out', loginWall: true, content: 'Sign in' }),
      tu('source_read', { _truncated: true, originalChars: 428000, head: '…' }),
    ],
  });
  assert.ok(lines.includes('#1 etrade_account → error: transactions failed: API error: 401 nonce_used'));
  assert.ok(lines.includes('#2 web_fetch → fell back to HTTP (extension timed out); returned a sign-in page'));
  assert.ok(lines.includes('#3 source_read → result truncated from 428000 chars'));
  assert.ok(!lines.some((l) => /no tool errors/.test(l)));
});

test('report: long results point at the "tool" index; failed turns are stated', () => {
  const long = T.turnReport({ text: 'ok', toolUses: [tu('web_fetch', { content: 'a'.repeat(5000) })] });
  assert.ok(long.some((l) => /^long results .*#0 web_fetch \(\d+ chars\)/.test(l)));
  assert.ok(T.turnReport({ text: '[Error: Empty response after 4 tool call(s)]' }).some((l) => /ended with an error/.test(l)));
  assert.ok(T.turnReport({ text: '[Stopped before an answer was written.]' }).some((l) => /stopped/.test(l)));
  assert.ok(T.turnReport({ text: 'half\n\n⚠ Answer cut off at the context limit' }).some((l) => /cut off/.test(l)));
  assert.equal(T.turnReport({ text: 'hi' })[0], 'no tools ran in that turn');
});

test('report: pipeline runs count steps and number tools like conversation_read', () => {
  const turn = {
    text: 'done',
    taskRun: [
      { text: 'a', toolUses: [tu('t0', { ok: 1 })] },
      { text: 'b', error: 'Stopped before this task finished.', subtasks: [
        { text: 'b1', toolUses: [tu('t1', { error: 'boom' })], contextTruncated: { cap: 1 } },
      ] },
    ],
  };
  const lines = T.turnReport(turn);
  assert.equal(lines[0], 'task pipeline run: 2 task(s), 2 step(s)');
  assert.ok(lines.includes('task 2 ended with an error: Stopped before this task finished.'));
  assert.ok(lines.some((l) => /^task 2: the previous step's output was clipped/.test(l)));
  assert.ok(lines.includes('#1 t1 → error: boom'));
  // the same index reads that result back
  const conv = { messages: [{ role: 'assistant', content: turn }] };
  assert.equal(readConversationPart(conv, { what: 'tools', message: 0, tool: 1 }).name, 't1');
});

test('prompt: empty problem → selected placeholder, exact conversation_read call, default guidance', () => {
  const p = T.buildPrompt({ message: 14, turn: { text: 'a', toolUses: [tu('web_search', {})], reasoning: 'r' } });
  assert.equal(p.text.slice(p.selectStart, p.selectEnd), T.PLACEHOLDER);
  assert.match(p.text, /^Troubleshoot your earlier answer \(message 14\)\.\n\nProblem: </);
  assert.ok(p.text.includes('conversation_read {"what":"tools","message":14}'));
  assert.ok(p.text.includes('conversation_read {"what":"reasoning","message":14}'));
  assert.ok(p.text.includes('Turn report (facts, not necessarily defects):\n- 1 tool call(s): web_search'));
  assert.ok(p.text.endsWith(T.DEFAULT_GUIDANCE));
  assert.ok(!p.text.includes('Part in question'));
});

test('prompt: typed problem and selection are carried; caret lands after the problem', () => {
  const p = T.buildPrompt({ message: 3, problem: '  P/E looks wrong ', selection: 'NVDA trades at\n 31x', turn: { text: 'a' } });
  assert.ok(p.text.includes('Problem: P/E looks wrong\n\nPart in question: "NVDA trades at 31x"'));
  assert.equal(p.selectStart, p.selectEnd);
  assert.equal(p.text.slice(0, p.selectStart).endsWith('P/E looks wrong'), true);
  assert.ok(p.text.includes('No tools ran in that turn'));
  assert.ok(!p.text.includes('conversation_read'));
});

test('prompt: a saved "Troubleshoot" prompt replaces only the guidance; applet-only turns get the applet call', () => {
  const p = T.buildPrompt({ message: 5, guidance: 'Verify every number.', turn: { text: '<applet type="html"><p>x</p></applet>' } });
  assert.ok(p.text.endsWith('Verify every number.'));
  assert.ok(!p.text.includes(T.DEFAULT_GUIDANCE));
  assert.ok(p.text.includes('conversation_read {"what":"applet","message":5}'));
});

test('turnFailed: error, stopped, cut-off and failed pipeline tasks keep the button visible', () => {
  assert.equal(T.turnFailed({ text: 'fine' }), false);
  assert.equal(T.turnFailed({ text: '[Error: x]' }), true);
  assert.equal(T.turnFailed({ text: '[Stopped before…]' }), true);
  assert.equal(T.turnFailed({ text: 'a ⚠ Answer cut off at the per-answer limit' }), true);
  assert.equal(T.turnFailed({ text: 'a', taskRun: [{ error: 'x' }] }), true);
});

test('conversation_read tool index: one result in full, list carries indexes and a note', () => {
  const big = 'a'.repeat(9000);
  const uses = Array.from({ length: 14 }, (_, i) => ({ name: `t${i}`, result: i === 13 ? big : 'ok' }));
  const conv = { messages: [{ role: 'assistant', content: { text: 'x', toolUses: uses } }] };
  const list = readConversationPart(conv, { what: 'tools' });
  assert.deepEqual([list.count, list.shown, list.toolUses[0].tool, list.toolUses.at(-1).tool], [14, 12, 2, 13]);
  assert.equal(list.toolUses.at(-1).truncatedFrom, 9000);
  assert.match(list.note, /"tool": <index>/);
  const one = readConversationPart(conv, { what: 'tools', tool: 13 });
  assert.equal(one.result.length, 9000);
  assert.equal(readConversationPart(conv, { what: 'tools', tool: 0 }).name, 't0');
  assert.match(readConversationPart(conv, { what: 'tools', tool: 14 }).error, /no tool 14/);
});
