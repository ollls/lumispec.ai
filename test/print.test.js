import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The markdown printer (Print button on an answer, /print.html): print.js loaded the way the
// page loads it — a plain script on a bare global. The print dialog itself needs a browser.
const SRC = readFileSync(new URL('../src/public/js/print.js', import.meta.url), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(SRC, sandbox);
const P = sandbox.window.Printer;
// Stand-ins for marked and DOMPurify: enough to see what is handed to them and what comes back.
const lib = { marked: { parse: (md) => `<p>${md}</p>` }, DOMPurify: { sanitize: (h) => h.replace(/<script[\s\S]*?<\/script>/g, '') } };

test('applets are left out of the printed text, closed or cut off at the end', () => {
  const md = 'Intro\n\n<applet type="html">\n<html><body><button onclick="window.print()">Print</button></body></html>\n</applet>\n\nOutro';
  const out = P.printableMarkdown(md);
  assert.equal(out, `Intro\n\n${P.APPLET_NOTE}\n\nOutro`);
  assert.ok(!/window\.print|<applet/.test(out));
  assert.equal(P.printableMarkdown('Text\n\n<applet type="chartjs"><canvas></canvas></applet'), `Text\n\n${P.APPLET_NOTE}`);
});

test('an answer that is only an applet has nothing to print here; one with text has', () => {
  assert.equal(P.hasPrintableText('<applet type="svg"><svg></svg></applet>'), false);
  assert.equal(P.hasPrintableText('  \n'), false);
  assert.equal(P.hasPrintableText(undefined), false);
  assert.equal(P.hasPrintableText('# Dinner\n\n| a | b |\n|---|---|\n| 1 | 2 |'), true);
  assert.equal(P.hasPrintableText('See the chart.\n<applet type="svg"><svg></svg></applet>'), true);
});

test('titleOf: the first heading without its markup, else the fallback, never empty', () => {
  assert.equal(P.titleOf('# Thanksgiving Dinner in **West Palm Beach** — Today\n\ntext'), 'Thanksgiving Dinner in West Palm Beach — Today');
  assert.equal(P.titleOf('Some text\n\n## Top Picks ##\n'), 'Top Picks');
  assert.equal(P.titleOf('no heading here', 'notes.md'), 'notes.md');
  assert.equal(P.titleOf('', ''), 'Lumispec answer');
  assert.equal(P.titleOf('#hashtag is not a heading', 'x'), 'x');
});

test('renderMarkdown goes through the sanitizer; documentHtml is a whole light page with an escaped title', () => {
  const body = P.renderMarkdown('Hello<script>alert(1)</script>', lib);
  assert.equal(body, '<p>Hello</p>');
  const html = P.documentHtml('A <b> & "c"', body);
  assert.ok(html.startsWith('<!doctype html>'));
  assert.match(html, /<title>A &lt;b&gt; &amp; &quot;c&quot;<\/title>/);
  assert.match(html, /background:#fff/);
  assert.match(html, /thead\{display:table-header-group\}/);   // table headers repeat on every page
  assert.ok(html.endsWith('<body><p>Hello</p></body></html>'));
  assert.throws(() => P.renderMarkdown('x', {}), /renderer has not loaded/);
});

test('printMarkdown prints nothing, and builds no frame, for an applet-only answer', () => {
  assert.equal(P.printMarkdown('<applet type="html"><p>x</p></applet>'), false);
});
