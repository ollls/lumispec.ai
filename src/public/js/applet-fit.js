// Applet fit — keeps a chart, SVG or image inside an applet from rendering taller than the
// chat area. Plain script (no modules): loaded by index.html ahead of app.js, and loaded by
// test/appletFit.test.js in a vm context, so everything here must stay self-contained.
//
// 2026-11-10: "Draw SPY chart" produced `<canvas id="chart" height="340">` with
// `responsive: true`. Chart.js keeps `maintainAspectRatio: true` by default and reads the
// canvas's own width/height (300 default × 340) as an aspect ratio, then scales the chart to
// the full bubble width — 1,556 × 1,763 px inside a 625 px chat area. Nothing in the app
// read the viewport, so the iframe simply grew to 1,839 px.
(function (root) {
  'use strict';

  var SHARE = 0.8;       // share of the visible chat area a visual may take
  var MIN_CAP = 240;     // never squash a chart below this
  var MAX_CAP = 1200;    // and never let a huge monitor undo the cap entirely
  var DEFAULT_CAP = 600; // when the chat area's height is unknown

  // Tallest height, in px, an applet's main visual may take for a chat area of the given height.
  function capFor(areaHeight) {
    var h = Number(areaHeight);
    if (!(h > 0)) return DEFAULT_CAP;
    return Math.max(MIN_CAP, Math.min(MAX_CAP, Math.round(h * SHARE)));
  }

  // CSS appended to the iframe's style reset: SVGs with a viewBox letterbox inside the cap and
  // images keep their ratio (width and height stay auto), so neither is distorted.
  function styleFor(cap) {
    return 'svg,img{max-height:' + cap + 'px}';
  }

  // Runs INSIDE the applet iframe. Registers a global Chart.js plugin whose beforeInit — which
  // fires before the chart's first resize — predicts the height responsive mode is about to
  // produce (container width ÷ aspect ratio) and, only when that exceeds the cap, wraps the
  // canvas in a fixed-height box and turns maintainAspectRatio off so the chart fills the box.
  // Small charts in dashboard grids and charts that already manage their own height are left
  // alone. If Chart.js has not loaded yet, a setter on window.Chart registers the plugin the
  // moment the UMD bundle assigns the global, so the injection order does not matter.
  function chartFit(cap) {
    var plugin = {
      id: 'lumispecFit',
      beforeInit: function (chart) {
        var o = chart.options || {};
        if (o.responsive === false || o.maintainAspectRatio === false) return;
        var canvas = chart.canvas;
        var parent = canvas && canvas.parentNode;
        if (!parent || typeof parent.insertBefore !== 'function') return;
        var width = parent.clientWidth || canvas.clientWidth || 0;
        var ratio = chart.aspectRatio;
        if (!(width > 0) || !(ratio > 0)) return;
        if (width / ratio <= cap) return;
        var box = document.createElement('div');
        box.className = 'lumispec-fit';
        box.style.cssText = 'position:relative;width:100%;height:' + cap + 'px';
        parent.insertBefore(box, canvas);
        box.appendChild(canvas);
        o.maintainAspectRatio = false;
      }
    };
    function register(Chart) {
      if (Chart && typeof Chart.register === 'function') Chart.register(plugin);
    }
    if (window.Chart) { register(window.Chart); return; }
    var held;
    Object.defineProperty(window, 'Chart', {
      configurable: true,
      enumerable: true,
      get: function () { return held; },
      set: function (v) { held = v; register(v); }
    });
  }

  // The <script> tag app.js injects into applets that load Chart.js.
  function chartScriptFor(cap) {
    return '<script>(' + chartFit.toString() + ')(' + (Number(cap) || DEFAULT_CAP) + ');<\/script>';
  }

  root.AppletFit = {
    SHARE: SHARE,
    MIN_CAP: MIN_CAP,
    MAX_CAP: MAX_CAP,
    DEFAULT_CAP: DEFAULT_CAP,
    capFor: capFor,
    styleFor: styleFor,
    chartFit: chartFit,
    chartScriptFor: chartScriptFor
  };
})(typeof window !== 'undefined' ? window : globalThis);
