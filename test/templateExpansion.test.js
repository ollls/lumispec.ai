import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandTemplateTags, templateInstruction } from '../src/services/templateExpansion.js';

const lookup = (name) => name === 'World NEWS' ? { type: 'html', html: '<div>8 outlets</div>' } : null;

test('a known tag becomes the instruction block with the template HTML inside', () => {
  const out = expandTemplateTags('Refresh [template: World NEWS] please', lookup);
  assert.ok(out.startsWith('Refresh \n\nUse this saved HTML applet template as the EXACT base'), out.slice(0, 80));
  assert.ok(out.includes('<applet type="html">'));
  assert.ok(out.includes('```html\n<div>8 outlets</div>\n```'));
  assert.ok(out.endsWith('``` please'));
});

test('an unknown tag is left in place and logged', () => {
  const lines = [];
  const out = expandTemplateTags('[template: Nope]', lookup, (l) => lines.push(l));
  assert.equal(out, '[template: Nope]');
  assert.deepEqual(lines, ['[template] expanding "Nope" → NOT FOUND']);
});

test('the instruction lifts the per-question fetch budget for the template\'s own sources', () => {
  const text = templateInstruction({ type: 'html', html: '' });
  assert.ok(text.includes('fetch EVERY one of them'));
  assert.ok(text.includes('budget does not apply to a template\'s own sources'));
  assert.ok(text.includes('Fetch up to 4 in parallel per round'));
  assert.ok(text.includes('instead of filling it from memory'));
  // the verbatim-copy rules are unchanged
  assert.ok(text.includes('Copy the template\'s HTML, CSS, and JavaScript VERBATIM.'));
  assert.ok(text.includes('Do NOT redesign, restyle, or reimagine the template.'));
});
