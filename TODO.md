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

Added 2026-11-21. Not run on either system; the table is from the code
(`src/services/llamaDashboard.js`).

**State in v1.6.2.** The panel opens and everything that comes from llama-server itself works
(Server, Model, Speed, tok/s in the top bar). What reads the machine is Linux-only:

| Card | macOS | Windows |
|---|---|---|
| Launch command, uptime, RAM | empty (`collectProcess()` reads `/proc`) | empty |
| Stability (Xid) | empty (`journalctl`) | empty |
| GPU | empty (no `nvidia-smi`) | should work with an NVIDIA card, without the llama-server / other split (no pid) |
| Updates | only with `LLAMA_CPP_DIR` (the checkout is located from the process) | only with `LLAMA_CPP_DIR` |

**Problems.**

- The empty cards give the Linux explanations ("No llama-server process was found… may run under
  another user or in a container", "The kernel log is not readable") instead of saying the
  reading is not supported on this system.
- Updates says the checkout was not found unless `LLAMA_CPP_DIR` is set.

**Fix.**

- [ ] Send the platform in the dashboard response and word each empty card for it ("not
      available on macOS / Windows"); Updates should name `LLAMA_CPP_DIR` as the way to turn it on.
- [ ] macOS: find the process with `ps -axo pid=,etime=,rss=,args=` (command line, uptime, RAM)
      and its binary path, so the launch command and the automatic checkout lookup work.
- [ ] Windows: the same through PowerShell (`Get-CimInstance Win32_Process`). Needs someone who
      can run it.
- [ ] Leave GPU memory on Apple Silicon and Stability on both systems empty, with an accurate
      message: there is no `nvidia-smi` equivalent on a Mac, and Xid is an NVIDIA-on-Linux log line.
- [ ] Correct the v1.6.2 notes' wording if any of this ships ("there the process, GPU and
      Stability cards report no reading").
