import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConversationPart, MAX_APPLETS_CHARS, MAX_TOOL_RESULT_CHARS, MAX_REASONING_CHARS } from '../src/services/conversationRead.js';

// The history rebuild replaces applets with "[Applet: TYPE visualization]" and drops tool rounds,
// so the model cannot see the code it is asked to fix. conversation_read hands the stored slice back.

const chart = '<html><body><canvas id="chart"></canvas><script>new Chart(x, {});</script></body></html>';
const conv = () => ({
  messages: [
    { role: 'user', content: 'draw SPY' },
    { role: 'assistant', content: { text: `Here:\n\n<applet type="chartjs">\n${chart}\n</applet>\n\nDone.`, reasoning: 'think A', toolUses: [{ name: 'run_python', result: '{"ok":true}' }] } },
    { role: 'user', content: 'thanks' },
    { role: 'assistant', content: 'You are welcome.' },
    { role: 'user', content: 'it is blank' },
    { role: 'assistant', content: '' }, // placeholder of the turn in flight
  ],
});

test('applet: defaults to the newest answer that has one and returns the exact source', () => {
  const r = readConversationPart(conv(), { what: 'applet' });
  assert.equal(r.message, 1);
  assert.equal(r.count, 1);
  assert.deepEqual(r.applets, [{ applet: 0, type: 'chartjs', chars: chart.length, html: chart }]);
});

test('applet: an unclosed applet at the end of the text is still read', () => {
  const c = { messages: [{ role: 'assistant', content: `<applet type="html">${chart}</appl` }] };
  assert.equal(readConversationPart(c, {}).applets[0].html, chart);
});

test('applet: explicit message must be an assistant answer that has one', () => {
  assert.match(readConversationPart(conv(), { message: 0 }).error, /user message/);
  assert.match(readConversationPart(conv(), { message: 3 }).error, /no applet/);
  assert.match(readConversationPart(conv(), { message: 40 }).error, /No message 40/);
  assert.equal(readConversationPart(conv(), { message: 1 }).applets.length, 1);
});

test('applet: several large applets are listed without source until one is asked for', () => {
  const big = '<div>' + 'x'.repeat(MAX_APPLETS_CHARS / 2 + 10) + '</div>';
  const c = { messages: [{ role: 'assistant', content: `<applet type="html">${big}</applet> and <applet type="svg">${big}</applet>` }] };
  const list = readConversationPart(c, {});
  assert.equal(list.count, 2);
  assert.equal(list.applets[0].html, undefined);
  assert.match(list.note, /"applet": <index>/);
  const one = readConversationPart(c, { applet: 1 });
  assert.equal(one.applets.length, 1);
  assert.equal(one.applets[0].type, 'svg');
  assert.equal(one.applets[0].html, big);
  assert.match(readConversationPart(c, { applet: 5 }).error, /no applet 5/);
});

test('tools: stored results come back, long ones cut with their original size', () => {
  const c = conv();
  c.messages[1].content.toolUses.push({ name: 'web_fetch', result: 'y'.repeat(MAX_TOOL_RESULT_CHARS + 500) });
  const r = readConversationPart(c, { what: 'tools' });
  assert.equal(r.message, 1);
  assert.equal(r.count, 2);
  assert.deepEqual(r.toolUses[0], { tool: 0, name: 'run_python', result: '{"ok":true}' });
  assert.equal(r.toolUses[1].result.length, MAX_TOOL_RESULT_CHARS);
  assert.equal(r.toolUses[1].truncatedFrom, MAX_TOOL_RESULT_CHARS + 500);
});

test('tools and reasoning: pipeline runs are read from their steps', () => {
  const c = { messages: [{ role: 'assistant', content: { text: 'run', taskRun: [
    { text: 'a', result: 'ra', reasoning: 'r1', toolUses: [{ name: 't1', result: '1' }] },
    { text: 'g', subtasks: [{ text: 's', result: 'rs', reasoning: 'r2', toolUses: [{ name: 't2', result: '2' }] }] },
  ] } }] };
  assert.deepEqual(readConversationPart(c, { what: 'tools' }).toolUses.map(t => t.name), ['t1', 't2']);
  assert.equal(readConversationPart(c, { what: 'reasoning' }).reasoning, 'r1\n\nr2');
});

test('reasoning: the end is kept when it is long', () => {
  const c = { messages: [{ role: 'assistant', content: { text: 'a', reasoning: 'a'.repeat(MAX_REASONING_CHARS) + 'END' } }] };
  const r = readConversationPart(c, { what: 'reasoning' });
  assert.equal(r.reasoning.length, MAX_REASONING_CHARS);
  assert.ok(r.reasoning.endsWith('END'));
  assert.equal(r.truncatedFrom, MAX_REASONING_CHARS + 3);
});

test('nothing to read, unknown part, missing conversation: errors, never a throw', () => {
  const empty = { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '' }] };
  assert.match(readConversationPart(empty, { what: 'applet' }).error, /No applet/);
  assert.match(readConversationPart(empty, { what: 'tools' }).error, /No tool results/);
  assert.match(readConversationPart(empty, { what: 'reasoning' }).error, /No reasoning/);
  assert.match(readConversationPart(empty, { what: 'answer' }).error, /Unknown "what"/);
  assert.match(readConversationPart(undefined, {}).error, /not found/);
});
