import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPLET_RE, appletBody, replaceApplets } from '../src/services/applets.js';

// 2026-10-31: a 19K-char html applet ended in `</applet` — the model emitted end-of-sequence
// instead of the final `>`. The strict regex matched nothing, so the dashboard rendered as
// sanitized markdown and the raw HTML went back into the model's context on every later turn.

const html = '<!DOCTYPE html><html><body><div id="x">Dashboard</div><script>run();</script></body></html>';
const sub = (text) => replaceApplets(text, (type, body) => `[${type}:${body.length}]`);

test('a closed applet with prose on both sides is replaced and the prose kept', () => {
  const out = sub(`Intro.\n\n<applet type="html">\n${html}\n</applet>\n\nSummary after.`);
  assert.equal(out, `Intro.\n\n[html:${html.length}]\n\nSummary after.`);
});

test('an applet whose closing tag lost its final character at the end of the text still matches', () => {
  const out = sub(`Here it is:\n\n<applet type="html">\n${html}\n</applet`);
  assert.equal(out, `Here it is:\n\n[html:${html.length}]`);
});

test('an applet with no closing tag at all at the end of the text still matches', () => {
  const out = sub(`<applet type='chartjs'>\n${html}`);
  assert.equal(out, `[chartjs:${html.length}]`);
});

test('two applets, the second one unclosed', () => {
  const out = sub(`<applet type="svg"><svg></svg></applet>\n\ntext\n\n<applet type="html">${html}</appl`);
  assert.equal(out, `[svg:11]\n\ntext\n\n[html:${html.length}]`);
});

test('appletBody strips only a cut-short closer, not real trailing markup', () => {
  assert.equal(appletBody(`${html}\n</applet`), html);
  assert.equal(appletBody(`${html}\n<`), html);
  assert.equal(appletBody(`${html}\n</applet>`), `${html}\n</applet>`); // a complete closer is not a cut-short one (APPLET_RE never passes one in)
  assert.equal(appletBody('<p>text</p>'), '<p>text</p>');
});

test('text without applets is untouched and the regex is reusable', () => {
  const plain = 'No applets here, just <b>bold</b> and a < sign.';
  assert.equal(sub(plain), plain);
  assert.equal(sub(plain), plain);
  assert.equal([...`<applet type="html">a</applet>`.matchAll(APPLET_RE)].length, 1);
});
