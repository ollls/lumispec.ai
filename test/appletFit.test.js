import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

// 2026-11-10: "Draw SPY chart" emitted `<canvas id="chart" height="340">` with responsive: true.
// Chart.js read the canvas's own 300×340 as an aspect ratio and scaled it to the 1,556px bubble:
// a 1,763px-tall chart in a 625px chat area. applet-fit.js caps charts, SVGs and images from the
// chat area's height; this suite drives the real script through a linkedom document.

const SRC = readFileSync(new URL('../src/public/js/applet-fit.js', import.meta.url), 'utf8');

// The script as the page loads it: `window.AppletFit` on a bare global.
function loadFit() {
  const sandbox = { window: {} };
  sandbox.window.window = sandbox.window;
  vm.runInNewContext(SRC, sandbox);
  return sandbox.window.AppletFit;
}

// The injected <script> as the iframe runs it: a fresh window holding a linkedom document, no
// Chart yet. (linkedom's own `window` is one shared object across parseHTML calls, so each test
// gets its own plain object as the global instead.)
function iframeWith(html) {
  const { document } = parseHTML(html);
  const win = { document };
  win.window = win;
  return { win, document, run: (code) => vm.runInNewContext(code, win) };
}

// A stand-in for Chart.js's global: collects registered plugins.
function fakeChartLib() {
  const plugins = [];
  return { plugins, register: (p) => plugins.push(p) };
}

// What Chart.js hands beforeInit for a canvas with the given attributes (ratio = width / height
// of the canvas's own render size, which is what maintainAspectRatio preserves).
function fakeChart(canvas, { ratio, options = { responsive: true } }) {
  return { canvas, options, aspectRatio: ratio };
}

function setWidth(el, px) {
  Object.defineProperty(el, 'clientWidth', { value: px, configurable: true });
}

const fit = loadFit();
const SPY_RATIO = 300 / 340; // canvas default width ÷ the height="340" attribute

test('capFor: 80% of the chat area, clamped, with a default when the height is unknown', () => {
  assert.equal(fit.capFor(625), 500);
  assert.equal(fit.capFor(100), fit.MIN_CAP);
  assert.equal(fit.capFor(5000), fit.MAX_CAP);
  assert.equal(fit.capFor(0), fit.DEFAULT_CAP);
  assert.equal(fit.capFor(undefined), fit.DEFAULT_CAP);
  assert.equal(fit.capFor('abc'), fit.DEFAULT_CAP);
});

test('styleFor caps SVGs and images only — never canvases, which Chart.js sizes itself', () => {
  const css = fit.styleFor(500);
  assert.equal(css, 'svg,img{max-height:500px}');
  assert.ok(!css.includes('canvas'));
});

test('chartScriptFor is a self-contained script that parses and carries the cap', () => {
  const tag = fit.chartScriptFor(500);
  assert.match(tag, /^<script>\(function chartFit\(cap\)[\s\S]*\)\(500\);<\/script>$/);
  assert.ok(!tag.includes('postMessage'), 'must not trip app.js\'s "has its own resize" check');
  const body = tag.replace(/^<script>/, '').replace(/<\/script>$/, '');
  assert.doesNotThrow(() => new vm.Script(body));
  assert.ok(fit.chartScriptFor(NaN).includes(`)(${fit.DEFAULT_CAP});`));
});

test('the SPY case: an oversized responsive chart is boxed at the cap with maintainAspectRatio off', () => {
  const { win, document, run } = iframeWith('<html><head></head><body><canvas id="chart" height="340"></canvas></body></html>');
  run(fit.chartScriptFor(500).slice('<script>'.length, -'</script>'.length));
  const lib = fakeChartLib();
  win.Chart = lib; // what the Chart.js UMD bundle does: `globalThis.Chart = factory()`
  assert.equal(lib.plugins.length, 1, 'plugin registered when the Chart global is assigned');
  assert.equal(lib.plugins[0].id, 'lumispecFit');

  const canvas = document.getElementById('chart');
  setWidth(document.body, 1556);
  const chart = fakeChart(canvas, { ratio: SPY_RATIO });
  lib.plugins[0].beforeInit(chart);

  const box = canvas.parentNode;
  assert.equal(box.className, 'lumispec-fit', 'canvas moved into the fit box');
  assert.equal(box.parentNode, document.body, 'box sits where the canvas was');
  assert.match(box.getAttribute('style'), /height:500px/);
  assert.equal(chart.options.maintainAspectRatio, false);
});

test('a chart that fits the cap is left exactly as written', () => {
  const { win, document, run } = iframeWith('<html><body><div class="cell"><canvas id="c"></canvas></div></body></html>');
  const lib = fakeChartLib();
  win.Chart = lib; // Chart already loaded when the fit script runs
  run(fit.chartScriptFor(500).slice('<script>'.length, -'</script>'.length));
  assert.equal(lib.plugins.length, 1);

  const canvas = document.getElementById('c');
  const cell = canvas.parentNode;
  setWidth(cell, 400);
  const chart = fakeChart(canvas, { ratio: 2 }); // 400 / 2 = 200px tall
  lib.plugins[0].beforeInit(chart);

  assert.equal(canvas.parentNode, cell, 'not wrapped');
  assert.equal(chart.options.maintainAspectRatio, undefined, 'options untouched');
});

test('charts that manage their own height (maintainAspectRatio: false, responsive: false) are skipped', () => {
  for (const options of [{ responsive: true, maintainAspectRatio: false }, { responsive: false }]) {
    const { win, document, run } = iframeWith('<html><body><canvas id="c"></canvas></body></html>');
    const lib = fakeChartLib();
    win.Chart = lib;
    run(fit.chartScriptFor(300).slice('<script>'.length, -'</script>'.length));
    const canvas = document.getElementById('c');
    setWidth(document.body, 3000);
    const chart = fakeChart(canvas, { ratio: 0.5, options });
    lib.plugins[0].beforeInit(chart);
    assert.equal(canvas.parentNode, document.body, `not wrapped for ${JSON.stringify(options)}`);
  }
});

test('the window.Chart setter keeps behaving as a plain global after Chart.js assigns it', () => {
  const { win, run } = iframeWith('<html><body></body></html>');
  run(fit.chartScriptFor(500).slice('<script>'.length, -'</script>'.length));
  assert.equal(win.Chart, undefined);
  const lib = fakeChartLib();
  win.Chart = lib;
  assert.equal(win.Chart, lib, 'reads back what was assigned');
  assert.equal(run('typeof window.Chart.register'), 'function', 'visible to the applet\'s own script');
});
