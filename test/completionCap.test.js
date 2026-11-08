import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitCompletionCap } from '../src/services/llm.js';

test('hitCompletionCap tells the per-answer cap apart from the context wall', () => {
  assert.equal(hitCompletionCap({ completion_tokens: 24576 }, 24576), true);
  assert.equal(hitCompletionCap({ completion_tokens: 30000 }, 24576), true);
  assert.equal(hitCompletionCap({ completion_tokens: 2200 }, 24576), false, 'a short answer cut at the wall');
  assert.equal(hitCompletionCap(null, 24576), false);
  assert.equal(hitCompletionCap({ completion_tokens: 99999 }, 0), false, '0 disables the cap');
});
