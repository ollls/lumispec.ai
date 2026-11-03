import { test } from 'node:test';
import assert from 'node:assert/strict';
import { truncatePrevResult } from '../src/services/pipelineContext.js';

const section = (name, body) => `## ${name}\n\n${body}`;
const merge = (parts) => parts.join('\n\n---\n\n');

test('under the cap: text passes through untouched', () => {
  const r = truncatePrevResult('hello', 100);
  assert.equal(r.text, 'hello');
  assert.equal(r.truncated, false);
  assert.equal(r.cut, null);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.notice, null);
});

test('a subtask group: names the cut section and every dropped one', () => {
  // 13 sections of ~1,000 chars; cap at 7,500 lands inside section 8 (sections 9–13 lost)
  const names = Array.from({ length: 13 }, (_, i) => `Fetch https://site${i + 1}.example/`);
  const merged = merge(names.map(n => section(n, 'x'.repeat(1000))));
  const r = truncatePrevResult(merged, 7500);
  assert.equal(r.truncated, true);
  assert.equal(r.from, merged.length);
  assert.equal(r.cut, names[7]);
  assert.deepEqual(r.dropped, names.slice(8));
  assert.match(r.notice, /first 7,500 of/);
  assert.match(r.notice, /cut mid-section: "Fetch https:\/\/site8\.example\/"/);
  assert.match(r.notice, /dropped entirely \(5\)/);
  // The model sees the warning first, the head, and a tail marker
  assert.ok(r.text.startsWith('> ⚠ **Previous output truncated'));
  assert.ok(r.text.includes(section(names[0], 'x'.repeat(1000))));
  assert.ok(!r.text.includes(names[8]) || r.text.indexOf(names[8]) < r.text.indexOf('[...truncated'), 'dropped sections appear only in the notice');
  assert.match(r.text, /\[\.\.\.truncated from \d+ chars; 5 section\(s\) dropped, cut inside "Fetch https:\/\/site8\.example\/"\]$/);
});

test('cap exactly on a section boundary: that section counts as dropped, not cut', () => {
  const a = section('A', 'a'.repeat(50));
  const merged = merge([a, section('B', 'b'.repeat(50))]);
  const cap = a.length + 7; // the separator; "## B" starts at `cap`
  const r = truncatePrevResult(merged, cap);
  assert.equal(r.cut, 'A');
  assert.deepEqual(r.dropped, ['B']);
});

test('flat prose with no sections: truncated, nothing to name', () => {
  const r = truncatePrevResult('p'.repeat(500), 100);
  assert.equal(r.truncated, true);
  assert.equal(r.cut, null);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.notice, 'Previous output truncated: showing the first 100 of 500 chars');
  assert.match(r.text, /\[\.\.\.truncated from 500 chars; 0 section\(s\) dropped\]$/);
});

test('deeper headers are not sections', () => {
  const merged = merge([section('A', '### sub\n' + 'a'.repeat(100)), section('B', 'b'.repeat(100))]);
  const r = truncatePrevResult(merged, 60);
  assert.equal(r.cut, 'A');
  assert.deepEqual(r.dropped, ['B']);
});
