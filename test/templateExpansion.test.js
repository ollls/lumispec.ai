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

test('template HTML with replacement patterns like \'$\' + v is inserted literally', () => {
  // String.replace treats $' $& $` $1 in a string replacement as patterns; the tag sat at the end
  // of the message, so `'$' + v` collapsed to `' + v` and the copied applet had an unterminated string
  const html = "const fmt$ = v => '$' + Number(v).toFixed(2); // $& $` $1 $$";
  const out = expandTemplateTags('[template: AMD]', (n) => n === 'AMD' ? { type: 'chartjs', html } : null);
  assert.ok(out.includes(html), out);
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

// ── Template notes ──────────────────────────────────────────────────────────────────────────
import { splitTemplateNotes, renderTemplateFile } from '../src/services/templateExpansion.js';

const NOTED = `<!DOCTYPE html>
<!-- SERIES CONTRACT — exactly three instruments.
     ASSISTANT: build chpy_smh_sox.csv first.
       header: date,chpy,smh,sox
     Then output this template VERBATIM. -->
<html><head><script>const suffix = /(_n|_norm)$/;</script></head><body>hi</body></html>`;

test('splitTemplateNotes lifts the leading comment off the markup, dedented, and keeps the doctype', () => {
  const { notes, html } = splitTemplateNotes(NOTED);
  assert.equal(notes, 'SERIES CONTRACT — exactly three instruments.\nASSISTANT: build chpy_smh_sox.csv first.\n  header: date,chpy,smh,sox\nThen output this template VERBATIM.');
  assert.equal(html, '<!DOCTYPE html>\n<html><head><script>const suffix = /(_n|_norm)$/;</script></head><body>hi</body></html>');
});

test('splitTemplateNotes joins several leading comments and leaves comments inside the markup alone', () => {
  const { notes, html } = splitTemplateNotes('<!-- one -->\n<!-- two -->\n<div><!-- keep --></div>');
  assert.equal(notes, 'one\n\ntwo');
  assert.equal(html, '<div><!-- keep --></div>');
});

test('a template without a leading comment is returned unchanged with empty notes', () => {
  const html = '<!DOCTYPE html>\n<html><body><!-- not leading --></body></html>';
  assert.deepEqual(splitTemplateNotes(html), { notes: '', html });
  assert.deepEqual(splitTemplateNotes(''), { notes: '', html: '' });
  assert.deepEqual(splitTemplateNotes(undefined), { notes: '', html: '' });
});

test('the instruction shows the notes outside the code fence and the fence holds markup only', () => {
  const { notes, html } = splitTemplateNotes(NOTED);
  for (const tpl of [{ type: 'html', html: NOTED }, { type: 'html', html, notes }]) {
    const text = templateInstruction(tpl);
    const fence = text.indexOf('```html\n');
    assert.ok(text.includes('Template notes — the author\'s instructions to you. They are NOT part of the HTML'));
    assert.ok(text.indexOf('build chpy_smh_sox.csv first') < fence, 'notes precede the fence');
    assert.ok(text.endsWith('```html\n' + html + '\n```'), 'the fence is the stripped markup');
    assert.ok(!text.slice(fence).includes('SERIES CONTRACT'), 'the comment is not in what the model copies');
  }
});

test('without notes the instruction text is byte-identical to the pre-notes version', () => {
  const text = templateInstruction({ type: 'chartjs', html: '<canvas></canvas>' });
  assert.ok(!text.includes('Template notes'));
  assert.ok(text.includes('instead of filling it from memory.\n```html\n<canvas></canvas>\n```'));
});

test('renderTemplateFile puts the notes back as a leading comment after the doctype and round-trips', () => {
  const split = splitTemplateNotes(NOTED);
  const file = renderTemplateFile({ ...split });
  assert.ok(file.startsWith('<!DOCTYPE html>\n<!--\nSERIES CONTRACT'), file.slice(0, 60));
  assert.deepEqual(splitTemplateNotes(file), split);
  assert.equal(renderTemplateFile({ html: '<div></div>' }), '<div></div>');
  assert.equal(renderTemplateFile({ html: '<div></div>', notes: 'n' }), '<!--\nn\n-->\n<div></div>');
});
