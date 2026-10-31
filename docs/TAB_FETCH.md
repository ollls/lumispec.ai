# Tab Fetch — reading the user's own open tabs

*Design and implementation plan, 2026-10-31. Status: steps 1–9 implemented the same day (extension 0.7.0, `browser_tabs`, `web_fetch { tab }`, host care, prompts, tests, docs); step 10 validation pending the extension reload. Divergences from the plan are listed at the end.*

## Why

The Browser Search extension fetches by URL: it opens the address in a hidden tab of the user's
Chrome, reads it, closes it. That is the right default and stays the main path. It cannot reach
anything that is not addressable by URL — a logged-in state behind two-factor, a CAPTCHA already
passed, a filtered board, a scrolled feed, a bank statement two clicks deep. The user can reach all
of those by hand in seconds.

Tab Fetch adds a second, explicit path: **the user opens and prepares a tab; the model reads it in
place.** The human drives, the model reads. This is the opposite division of labour from the April
2026 "Page Agent" prototype (`origin/page_agent_archive`), which let a third-party extension's own
planner click and type; that branch stays parked.

A visible, active tab also has real layout, so `innerText` is exact there and the computed-style
walker from v1.4.3 is not needed on this path.

## Rules (decided)

1. **Arguments decide the mode, never a guess.** `web_fetch({ url })` opens a hidden tab as today.
   `web_fetch({ tab })` reads an existing tab and needs no URL. Both given → `url` is the match
   string for the tab; it fails if no such tab is open, it never falls back to opening one.
2. **The paths never touch each other's tabs.** The hidden fetch closes only tabs it created. The
   read path never navigates, reloads, closes, activates or scripts anything beyond reading. The
   tab listing hides the extension's own transient tabs. Hidden tabs stay `active: false`.
3. **One match reads; zero or several asks.** A match string must resolve to exactly one tab,
   otherwise the tool returns the candidates and the model has to ask the user. This rule lives in
   the extension and the tool, not in the model's judgment.
4. **Sites the user has open are treated with care.** Before a hidden fetch, the extension checks
   for open tabs on the same host:
   - same URL open → read that tab in place (toggle *Reuse my open tab when the address matches*,
     default **on**) and say so in the result;
   - same host, different URL → proceed with the hidden tab (main path) but attach the user's open
     tabs on that host as `openTabs` with a one-line hint, so the model can offer to read one;
   - toggle *Never open hidden tabs on sites I have open* (default **off**): the second case returns
     the open tabs and stops.
5. **Opt-in and disclosed.** Listing and reading tabs is off until the user enables *Let the
   assistant read my open tabs* on the Browser Search card. *Confirm before reading a tab* (default
   **on**) routes every read through the existing approve/deny prompt, naming the tab. Every result
   says which tab it came from (title, host, `lastAccessed`).
6. **`tab: "active"` never reads the Lumispec UI itself.** If the active tab is the app's own page
   the tool says so and the model asks which tab was meant.

## Non-goals (this iteration)

- No clicking, typing, scrolling or navigation in user tabs. "Scroll this tab and read again" is a
  possible later step and is deliberately excluded here.
- No screenshots / vision path.
- No reading of incognito windows (Chrome excludes them unless the user allows the extension there;
  nothing to do on our side).

## Architecture touchpoints

| Layer | File | Today | Change |
|---|---|---|---|
| Extension | `extension/background.js` | one request type `fetch { url, … }`; `runFetch()` creates a tab inside `serialized()`; `extractPage()` / `probeReady()` injected | add `tabs` and `read { tabId }` request types; track own tab ids; host lookup before `fetch` |
| Bridge | `src/services/browserBridge.js` | `fetchPage(url, opts)` over `#request()` | add `listTabs()` and `readTab(tabId, opts)`; surface `tabs` capability from the `hello` message |
| Plugin | `src/tools/plugin-browser.js` | `web_fetch { url, view }`; card fields (`dumpPages`, shared cap) | new tool `browser_tabs`; `web_fetch { tab }`; resolution + guards; three toggles; `openTabs` hint; confirmation |
| Prompt | `plugin-browser.js` `prompt` / `routing` | view guidance | when to list/read tabs; one-match rule; never guess |
| Panel | `src/public/js/app.js` | generic fields | nothing new (boolean fields already render) |
| Docs/tests | `CLAUDE.md`, `docs/WEB_RESEARCH.md`, `extension/README.md`, `docs/HELP.md`, `test/` | — | document; unit-test resolution and guards |

## Step-by-step

### Step 1 — Extension: list and read (v0.7.0)

1. **Own-tab registry.** `runFetch()` adds the created tab id to a `Set` (`ownTabs`) and removes it
   in `finally`. Every listing and every host check filters these out.
2. **`tabs` request** → `chrome.tabs.query({})`, mapped to
   `{ id, windowId, active, title, url, lastAccessed, incognito }`, own tabs removed, `chrome://`
   and extension pages removed. Reply `{ type: 'tabs', id, tabs }`.
3. **`read` request** `{ id, tabId, maxChars?, textMaxChars? }` → inside `serialized()`:
   `chrome.tabs.get(tabId)` (reject "tab closed" if missing or if it is an own tab), then one
   `chrome.scripting.executeScript({ target: { tabId }, func: extractPage, args })`. No
   `waitForTabLoad`, no settle loop: the user's tab is in whatever state they left it, and that is
   the point. Reply the same `page` shape as `fetch`, plus `{ tab: { id, title, url, active,
   lastAccessed } }`. Never call `tabs.update`, `tabs.remove`, `windows.update`.
4. **Host check inside `fetch`.** Before `tabs.create`, query open tabs on the request's host
   (own tabs excluded). Return `openTabs: [...]` alongside the page in every `fetch` reply; the
   server decides what to do with it (keeps policy out of the extension, so toggles need no reload).
   When the server sends `fetch { url, reuseTabId }` (it already found an exact match via `tabs`),
   skip creation and read that tab instead — this keeps "same URL → read in place" a single round
   trip without the extension knowing the toggle.
5. **`hello`** advertises `capabilities: ['fetch', 'tabs', 'read']`. Popup shows the count of
   readable tabs in its status line.
6. Manifest `0.7.0`. Self-contained check for injected functions as in v1.4.3 (no module scope).

*Acceptance:* with the extension reloaded, the popup's Test box can list tabs and read the active
one; a `read` of a closed tab id rejects with "tab closed"; hidden fetches still work unchanged.

### Step 2 — Bridge: two methods, one capability flag

1. `listTabs()` → `#request({ type: 'tabs' }, timeout)` → `tabs` array.
2. `readTab(tabId, opts)` → `#request({ type: 'read', tabId, ...opts })` → `{ ...page, tab, ms }`.
3. `fetchPage(url, opts)` passes through `reuseTabId` when given and returns `openTabs`.
4. `info.extension.capabilities` already exists; the plugin uses it to decide whether the tabs
   feature is available (extension older than 0.7.0 → tool reports "reload the extension").

*Acceptance:* `node --test` with a fake socket covers request/response pairing for the two new
types (the bridge's `#request` is already timeout-guarded; reuse that).

### Step 3 — Plugin: card toggles and config

Add to `DEFAULTS`: `readTabs: false`, `confirmTabReads: true`, `reuseOpenTab: true`,
`protectOpenSites: false`. Add four boolean fields to `configUi().fields` with one-line notes:

- *Let the assistant read my open tabs* — "Lists tab titles and URLs to the model on request. Off: the
  `browser_tabs` tool and `web_fetch { tab }` are unavailable."
- *Confirm before reading a tab* — "Approve each read; names the tab."
- *Reuse my open tab when the address matches* — "A fetch of an address you already have open reads
  that tab instead of loading it again."
- *Never open hidden tabs on sites I have open* — "Return your open tabs and stop instead of loading
  more pages on a site you are logged into."

`cardStatus` mentions the tab feature state once the extension advertises it.

### Step 4 — Plugin: `browser_tabs` tool

- `tools.browser_tabs`: no parameters; `condition` not needed — the tool returns
  `{ error: 'Reading open tabs is off — enable it on the Browser Search card' }` when `readTabs` is
  false, and "reload the extension" when the capability is missing.
- Returns `{ tabs: [{ id, title, host, url, active, lastAccessed }], activeIsLumispec: bool }`.
  URLs are trimmed of query strings longer than 80 chars in the model-facing copy (titles carry the
  meaning; long tracking URLs waste context), full URL kept in `_markdown` for the UI.
- Logged with `logToolCall('browser_tabs', 'call', …)` like every tool.

### Step 5 — Plugin: `web_fetch { tab }`

1. Parameters become `{ url: 'string', view: 'string', tab: 'string' }`; description gains:
   `"tab"`: `"active"`, a tab id from `browser_tabs`, or a host/title fragment that matches exactly
   one open tab — reads the user's tab in place, no URL needed; use it when the user says "look at
   this", "my X tab", or when a site needs their login or an action they did by hand.
2. **Resolution** (`resolveTab(spec, tabs)` — pure, unit-tested):
   - `"active"` → the active tab of the most recently focused window; if its URL is the app's own
     origin → `{ error: 'The active tab is Lumispec itself — which tab did you mean?', tabs }`.
   - numeric → by id, else `{ error: 'tab closed', tabs }`.
   - string → case-insensitive match on host (suffix) or title (substring); exactly one → it;
     zero → `{ error: 'no open tab matches', tabs }`; several → `{ error: 'several tabs match —
     ask the user which', candidates }`.
3. **Guards:** `readTabs` off → error naming the toggle. `confirmTabReads` on → `requestConfirmation(
   conversationId, 'Read tab: <title> (<host>)')` through the existing confirm flow; denied → error,
   nothing read. `autorun` does **not** bypass this confirmation (same as `source_project`).
4. **Read:** `bridge.readTab(id, {})` → `view` applies exactly as for a hidden fetch (`text` from
   `page.text`, `article` from `page.html`); same cap, same `renderedText()` / `htmlToMarkdown()`.
   Result adds `source: 'tab'`, `tab: { title, host, lastAccessed }`, `_tier: 'extension (tab)'`.
   Never falls back to HTTP: there is no URL-driven fetch implied by reading a tab.
5. Route log: `logToolCall('web_fetch', 'tab_read', { tab })`.

### Step 6 — Plugin: host care on hidden fetches

In the `url` path, before `fetchWithRetry`:

1. If `readTabs` is on and the extension has `tabs`: `const tabs = await bridge.listTabs()` (cheap,
   cached for the duration of one tool round).
2. Exact URL match (normalized: scheme+host+path+hash, query stripped of `utm_*`) and
   `reuseOpenTab` on → `bridge.fetchPage(url, { reuseTabId })`; result carries
   `source: 'tab'` and a note "read from your open tab, not reloaded".
3. Same host, different URL:
   - `protectOpenSites` on → return `{ error: 'You have <host> open; not loading more pages there.
     Say which tab to read.', openTabs }`.
   - otherwise proceed; attach `openTabs` (that host only) and `hint: 'The user has this site open;
     offer to read that tab instead of loading pages in the background.'`
4. `readTabs` off → none of this runs; behavior identical to v1.4.3.

### Step 7 — Prompt and routing

Add to the Browser Search `prompt` (only when `readTabs` is on — build the string in `prompt` from
config, as `getSystemPrompt()` re-reads plugin prompts per message):

- "The user may have the page open already. When they say 'look at this', 'my X tab', or the site
  needs their login or an action they did by hand, call `browser_tabs` and read with `web_fetch
  { tab }`. One tab must match; if several do, ask which. Never navigate or act in the user's tabs."
- Routing line: `- "look at my tab / this page / what I have open" → browser_tabs, then web_fetch { tab }`.

### Step 8 — Tests

- `test/tabFetch.test.js`: `resolveTab()` — active, numeric, host suffix, title substring, zero,
  several, active-is-Lumispec; URL normalization for reuse (`utm_*` stripped, hash kept, trailing
  slash); guard outcomes for the four toggles with a stubbed bridge; `openTabs` attachment.
- Extension: no harness; the popup Test box gains "List tabs" and "Read active tab" for manual checks.

### Step 9 — Docs

- `CLAUDE.md`: Browser Search section (rules 1–6, protocol fields, toggles), Registered Tools row
  for `browser_tabs`, `web_fetch` row gains `tab`.
- `docs/WEB_RESEARCH.md`: "Reading the user's tabs" subsection; `extension/README.md`: protocol
  and troubleshooting rows ("several tabs match", "tab closed", "active tab is Lumispec");
  `docs/HELP.md`: one paragraph in plain language — turn it on, say "look at my Chase tab", approve
  the prompt.
- `docs/TAB_FETCH.md` (this file): update status and record what diverged.

### Step 10 — Validation before release

- Hidden fetch unchanged with all toggles off (Reuters, NYT, Gmail text view as in v1.4.3).
- Two bank-like tabs open (any two logged-in sites): "look at my <A> tab" reads A; "look at my bank"
  returns both and the model asks; `tab: "active"` with the app focused asks.
- Reuse: open a URL by hand, fetch the same URL → `source: 'tab'`, no new tab flashes in the tab
  strip. Same host, other URL → hidden fetch plus `openTabs` hint; with *protect* on → stops.
- Confirmation: denied read reads nothing; `autorun` does not skip it.
- Close the tab between listing and read → "tab closed".
- Extension reload required once (0.7.0); ship under a minor release with the usual notes.

## Open questions

- Should `tab: "active"` be allowed while *Confirm before reading* is off? Proposed: yes — the user
  is looking at it; the risk case is the model picking a background tab on its own.
- `lastAccessed` is Chrome 121+; absent on older builds — treat as unknown, not as stale.
- Whether `openTabs` hints should be attached for *every* host or only hosts with cookies: Chrome
  does not expose "logged in", so every host it is; the hint is one line.
- Later step, separately scoped: "scroll this tab and read again" for infinite feeds.

## What diverged during implementation

- `fetch { openTabs: true }` is opt-in per request rather than always reported, so tab titles do not
  travel to the server at all while the master toggle is off.
- `tabs` and `read` reply as `type: 'result'` frames (with `tabs` / `page` + `tab` payloads) so the
  bridge's existing pairing handles them; no new frame types.
- The read flow lives in an exported `readUserTab({ spec, url, view, context, deps })` with injectable
  bridge/config, and the decisions in pure `resolveTab()` / `hostCarePlan()`, so the guards are
  unit-tested without Chrome (`test/tabFetch.test.js`); the bridge has its own fake-extension test.
- `prompt` and `routing` became functions (index.js resolves them per prompt build) instead of a
  config-time string, so the guidance tracks the toggle without a restart.
- A discarded (memory-saver) tab is listed but never reused or read; the error tells the user to
  click it once.
- Reuse of an exactly-matching open tab (rule 4, first case) does **not** go through the approval
  prompt: the model asked for that address by URL, and a hidden fetch would have loaded it with the
  same cookies and returned the same content. Approval guards reads the model chose by tab, where
  the user never named an address.
- Validated live on 2026-10-31 with six tabs open (two GitHub, Gmail, E*TRADE, Bank of America,
  Chase): "my github tab" → asked between the two; "my Chase tab" and `active` (Chase focused) →
  prompt named the host, decline read nothing; a GitHub tab read in place in 9 ms (4,877 chars of
  on-screen text); a hidden fetch of the open `tree/dev` address was reused (`source: tab`, 7 ms);
  `/pulls` on the same host fetched hidden with both GitHub tabs as the hint; with *protect* on it
  stopped and named the tabs; tab id 999999 → "closed or not readable".

