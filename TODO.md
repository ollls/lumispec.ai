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

## First request after an app start re-reads the whole prompt

Added 2026-11-21.

**Seen.** In a freshly started app, the second turn of the first conversation reused nothing from
llama-server's KV cache: 7,287 of 7,287 prompt tokens were read again (`cacheN: 0` in the Llama
Dashboard's speed record). The next conversation's turns each re-read 81 to 90 tokens, and the
same three-turn pattern sent straight to llama-server reuses the cache normally, so the server is
not the cause.

**Likely cause, not confirmed.** The system prompt differs between the first and the second
request after a start. Several plugins build their prompt section from a cache and refresh it in
the background (`cachedResearchLimits()` in the web plugins, the Books and Tab Fetch caches), so
the first build can use defaults and the second the saved values.

**Cost.** About two seconds, once per app start, on a 7K-token prompt.

- [ ] Diff the system prompt of the first and second request after a start.
- [ ] If it differs: warm those caches in `loadPlugins()` before the server starts listening.

## Llama Dashboard on macOS and Windows

Added 2026-11-21, decided the same day: **keep it simple.** Off Linux the dashboard probes
nothing on the machine (not even `nvidia-smi` on Windows) and shows only what llama-server
reports itself: Server, Model and Speed, plus Updates when `LLAMA_CPP_DIR` names a checkout. The
same rule applies everywhere: a card with nothing to show is left out, and one line under the
cards says what the full panel needs (Linux, an NVIDIA card, llama-server on the same machine).

Simulated by starting the app with `process.platform` set to `darwin` and `win32`; not run on a
real Mac or Windows machine.

Only if someone asks for more:

- [ ] macOS: process, launch command and uptime through `ps`, which would also locate the
      checkout for Updates without `LLAMA_CPP_DIR`.
- [ ] Windows: the same through PowerShell (`Get-CimInstance Win32_Process`), and `nvidia-smi`
      for the GPU card. Needs someone who can run it.

## Notes editor for templates

Added 2026-11-22.

**Problem.** A template's notes (the author's instructions to the assistant: which files to build,
which symbols to fetch, what never to change) can only be created by putting an HTML comment at the
top of the markup before saving, or by calling `PATCH /api/templates/:id` by hand. The Templates
menu shows them (☰ with a tooltip, `renderTemplates` area of `src/public/js/app.js`) but cannot
add or change them, and the only user-facing mention is one line in the README's v1.5.4 summary.
Of the 10 saved templates one has notes (CHPY), the one written on purpose.

**Fix.** The route already accepts `notes` (an empty string clears them), so this is frontend plus
docs:

- [ ] Show ☰ on every template row (dimmed when there are no notes) and open a small editor on
      click: a textarea with the current notes, Save and Cancel, Escape cancels.
- [ ] Save through `PATCH /api/templates/:id` with `{ notes }` and refresh the row.
- [ ] Say in the editor what notes are for in one line: instructions the assistant reads with the
      template and does not copy into the applet.
- [ ] Describe notes in the user docs (README's Templates section), including the leading-comment
      convention and `template_save` writing them back.
