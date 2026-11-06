import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampResearchLimits, researchLimitLine, researchLimitFields, RESEARCH_LIMITS } from '../src/tools/plugin-web.js';

// "I have a budget of 3 web_fetch calls" (2026-11-04): the budget is one sentence in the Web
// Research prompt section, not a loop limit. These cover the pure pieces behind making it a
// card setting shared by Web Search & Fetch and Browser Search.

test('defaults are the historical 3 searches + 3 fetches', () => {
  assert.deepEqual(clampResearchLimits(undefined), { maxSearchesPerQuestion: 3, maxFetchesPerQuestion: 3 });
  assert.deepEqual(clampResearchLimits({}), RESEARCH_LIMITS);
});

test('saved values are clamped to 0–10 and rounded; junk falls back per key', () => {
  assert.deepEqual(clampResearchLimits({ maxSearchesPerQuestion: '7', maxFetchesPerQuestion: 25 }),
    { maxSearchesPerQuestion: 7, maxFetchesPerQuestion: 10 });
  assert.deepEqual(clampResearchLimits({ maxSearchesPerQuestion: -2, maxFetchesPerQuestion: 'abc' }),
    { maxSearchesPerQuestion: 0, maxFetchesPerQuestion: 3 });
  assert.equal(clampResearchLimits({ maxFetchesPerQuestion: 2.6 }).maxFetchesPerQuestion, 3);
});

test('the prompt line names both limits by default, pluralised', () => {
  const line = researchLimitLine(RESEARCH_LIMITS);
  assert.ok(line.startsWith('\n- Maximum 3 web_search calls and 3 web_fetch calls per user question.'), line);
  assert.ok(line.includes('tell the user what you could not retrieve'));
  assert.equal(researchLimitLine({ maxSearchesPerQuestion: 1, maxFetchesPerQuestion: 1 }).includes('1 web_search call and 1 web_fetch call per'), true);
});

test('a 0 drops that half of the sentence; both 0 drop the line', () => {
  const fetchOnly = researchLimitLine({ maxSearchesPerQuestion: 0, maxFetchesPerQuestion: 5 });
  assert.ok(fetchOnly.includes('Maximum 5 web_fetch calls per user question'), fetchOnly);
  assert.ok(!fetchOnly.includes('web_search'));
  const searchOnly = researchLimitLine({ maxSearchesPerQuestion: 2, maxFetchesPerQuestion: 0 });
  assert.ok(searchOnly.includes('Maximum 2 web_search calls per user question'), searchOnly);
  assert.ok(!searchOnly.includes('web_fetch'));
  assert.equal(researchLimitLine({ maxSearchesPerQuestion: 0, maxFetchesPerQuestion: 0 }), '');
});

test('card fields target the shared web entry and carry the current values', () => {
  const fields = researchLimitFields({ maxSearchesPerQuestion: 4, maxFetchesPerQuestion: 6 });
  assert.deepEqual(fields.map(f => [f.key, f.group, f.type, f.value, f.min, f.max]), [
    ['maxSearchesPerQuestion', 'web', 'number', 4, 0, 10],
    ['maxFetchesPerQuestion', 'web', 'number', 6, 0, 10],
  ]);
});
