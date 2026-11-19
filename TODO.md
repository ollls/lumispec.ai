# TODO

## Isolate applets from the app

Added 2026-11-14.

**Problem.** Applet iframes are created with `sandbox="allow-scripts allow-same-origin"`
(`src/public/js/app.js`, `createAppletIframe()`). With both flags on a `srcdoc` iframe the applet
runs with the app's own origin, so its script can:

- call every API route the page can: approve a pending command (`/api/conversations/:id/confirm`),
  toggle plugins, use the E*TRADE routes while connected;
- read any local file through `/api/file?path=…`;
- reach into the parent page (`window.parent.document`) and remove its own sandbox attribute.

Applet code is written by the model, and the model reads web pages, so an instruction injected into
a fetched page can end up as script with full access to the app. The README lists "Sandboxed
iframes" under Safety defaults, which overstates what this gives.

**Why it is this way.** `allow-same-origin` was added so applets can `fetch('/files/…')` for their
data (commit `eb126e1`).

**Fix.** Drop `allow-same-origin`, so the iframe gets an opaque origin, and open only what applets
need to that origin:

- [ ] Send a CORS header (`Access-Control-Allow-Origin: *`, GET only) on `/files/*` and `/lib/*`,
      and on nothing else.
- [ ] Do the same for `GET /api/files?match=…`: the template review tells templates to discover
      their data files with it (`REVIEW_SYSTEM_PROMPT` in `src/services/templateReview.js`).
- [ ] Decide what to do about `/api/file?path=…`. The applet prompt tells the model to use it for
      local images. An `<img>` still loads it cross-origin, but it serves any absolute path, so
      consider limiting it to image types or to chosen directories.
- [ ] Set `iframe.sandbox = 'allow-scripts'` and check what else relied on the shared origin:
      the resize `postMessage`, the applet diagnostics script (`APPLET_DIAG_SCRIPT`), the
      Chart.js fit plugin (`applet-fit.js`), and the Troubleshoot report, which reads the
      iframe's document from the parent (rendered height, visible text, canvas count) and would
      have to get those by `postMessage` instead.
- [ ] Run every saved template and a few fresh applets (svg, chartjs, html with a `/files/` fetch)
      and confirm they still load their data and resize.
- [ ] Update the README's Safety defaults line and the Security note in `CLAUDE.md` to say what the
      sandbox does and does not isolate.

**Wording corrected 2026-11-14.** The README's Safety defaults and the Security note in
`CLAUDE.md` now say applets run with the app's origin and are not isolated. The last checkbox above
is for rewriting those lines again once the fix lands.
