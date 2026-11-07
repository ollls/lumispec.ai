import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoTitle } from '../src/routes/conversations.js';

test('a template-only message is titled after the template, not the expanded instruction', () => {
  assert.equal(autoTitle('[template: CHPY]'), 'Template: CHPY');
  assert.equal(autoTitle('  [template: World NEWS] [template: Weather] '), 'Template: World NEWS, Weather');
});

test('ordinary messages keep the first sentence, capped at 120 chars', () => {
  assert.equal(autoTitle('Compare CHPY with SMH. Then chart it.'), 'Compare CHPY with SMH.');
  assert.equal(autoTitle('Refresh [template: CHPY] with 2y of data'), 'Refresh [template: CHPY] with 2y of data');
  assert.equal(autoTitle('x'.repeat(130)), 'x'.repeat(120) + '…');
  assert.equal(autoTitle(''), '');
  assert.equal(autoTitle(undefined), '');
});
