# LLM Workbench

## Project Overview
Multi-conversation chat interface connected to a local llama-server. Express-based web app with a dark-themed chat UI, SSE streaming, and slot management. In-memory store (no persistence across restarts).

## Tech Stack
- **Runtime**: Node.js (ES modules)
- **Framework**: Express v5
- **CSS**: Tailwind CSS v4 (CLI build)
- **Frontend**: Vanilla JS, no bundler
- **LLM Backend**: llama.cpp server (OpenAI-compatible `/v1/chat/completions` endpoint)
- **GPU**: NVIDIA RTX 5090
- **Dependencies**: `@mozilla/readability`, `linkedom`, `turndown` (web content extraction), `oauth` (E*TRADE), `dotenv`

## LLM Server Configuration
Running Qwen3.8-27B (dense) on RTX 5090 (recommended backend; Gemma also supported — see README
"Choosing & running your model"). This is the configuration proven stable over long multi-step tool
flows — see the stability note below before adding flags:

```bash
export CUDA_VISIBLE_DEVICES=0  # Ensure RTX 5090 is used

./llama.cpp/build/bin/llama-server \
  -hf unsloth/Qwen3.8-27B-GGUF:Q6_K_XL \
  --n-gpu-layers 99 \
  --ctx-size 64000 \
  --flash-attn on \
  --cache-type-k q8_0 \
  --cache-type-v q8_0 \
  --spec-default \
  --spec-type draft-mtp \
  --temp 1.0 \
  --top-p 0.95 \
  --top-k 20 \
  --min-p 0.0 \
  --jinja \
  --port 8080
```

Notes that matter for the code:
- **`--ctx-size 64000`** is the source of truth for the context budget. It is the **per-slot**
  window in current llama.cpp builds, not a total split across slots — verified by feeding one slot
  a 56,001-token prompt untruncated while 4 slots were live. Both tool loops read the live slot's
  `n_ctx` via `slots.getSlotContextSize()` and wind down at 80% (~51K tokens) — see **Context
  Budget** below. `LLAMA_MAX_CONTEXT` in `.env` is only the fallback when slots are unreachable, and
  must not exceed the real window or the wind-down never fires.
- **`--cache-type-k/v q8_0`** (quantized KV cache) is what fits a 64K per-slot window next to a Q6
  27B. It requires `--flash-attn on`, so keep that explicit rather than relying on `auto`.
- **Slot count** is llama-server's default (4). Each slot carries its own full `--ctx-size`, so more
  slots cost VRAM (≈30.8 GB of 32 GB at 64K × 4) without changing any conversation's usable window.
- **`--spec-default` / `--spec-type draft-mtp`** — MTP speculative decoding, aimed at the tool-loop
  workload that dominates here.
- **Stability:** a tuned variant (`UD-Q6_K_XL`, `--ctx-size 65536`, `-np 1`, `--spec-draft-n-max 3`,
  `--cache-reuse 256`) produced an `NVRM: Xid 8` GPU channel hang under a tool-heavy session
  (2026-08-29 10:31; RC watchdog killed llama-server, no reboot required). `CRASH.md` records an
  earlier `Xid 79` on a different config. Change one flag at a time and watch
  `journalctl -k | grep Xid`.

## Project Structure
```
src/
  config.js                # Centralized config from .env (port, llama URL, search, etrade, liteapi, python, location, sourceDir, sourceTest)
  server.js                # Express server, entry point, calls loadPlugins() before listen, starts slot polling
  tools/
    index.js               # Core: plugin loader, registry, executor, parser, logging, confirmation, system prompt assembly, precision rules, plugin config
    plugin-core.js         # current_datetime
    plugin-web.js          # web_search, web_fetch + Tavily/Keiro search backends
    plugin-execution.js    # run_python
    plugin-source.js       # source_read/write/edit/delete/git/run/test/project, template_save + file locks, diff helpers
    plugin-travel.js       # hotel, travel, booking + rate map cache, guest profile persistence
    plugin-etrade.js       # etrade_account + CSV/Markdown formatters, summarize helpers
    plugin-browser.js      # web_search/web_fetch via the Chrome extension bridge; owns the engine table (URLs + linkedom parsers); supersedes 'web'
    plugin-obsidian.js     # Obsidian export card + obsidian_export tool; manual Save to Obsidian only (off by default)
  routes/
    conversations.js       # CRUD + POST /:id/messages (SSE streaming), confirm/deny commands, refine endpoint
    tasks.js               # Task pipeline CRUD + reorder
    taskProcessor.js       # Task pipeline execution engine (context chaining, subtask merging, SSE events)
    slots.js               # Slot status, pin/unpin endpoints
    health.js              # Health checks: llama, internet, search engines (keiro/tavily), liteapi
    etrade.js              # E*TRADE OAuth flow (status, auth start, auth complete, disconnect)
    prompts.js             # Prompt library CRUD + reorder + LLM-generated titles
    sessions.js            # Session prompts CRUD (upsert by color, reorder, PATCH title, LLM-generated titles)
    tools.js               # List tools, toggle enable/disable (individual tool level)
    templates.js           # Template CRUD, sanitizer, LLM optimize endpoint
  services/
    conversations.js       # Conversation store (Map-based, pinned convs persisted to data/pinned/)
    llm.js                 # llama-server client (streaming, non-streaming, SSE parser), prompt sizing + tool-result trimming
    tools.js               # Backward-compat barrel (re-exports from ../tools/index.js)
    slots.js               # Slot monitor (polling, assignment, pin/unpin, per-slot n_ctx lookup)
    browserBridge.js       # WebSocket endpoint /ws/browser for the Chrome extension (search/fetch requests, heartbeat, token)
    obsidian.js            # Obsidian export: vault registry lookup, pure renderNote(), atomic exportConversation()
    prompts.js             # Prompt library persistence (data/prompts.json)
    sessions.js            # Session prompts persistence (data/sessions.json), upsert by color
    etrade.js              # E*TRADE OAuth 1.0a client + API wrapper
    liteapi.js             # LiteAPI hotel/travel client
    templates.js           # Template persistence + reorder + update
    tasks.js               # Task pipeline persistence (data/tasks.json)
  views/index.html         # Main chat UI (full-width top bar, sidebar, slot panel)
  public/js/app.js         # Client-side: conversations, streaming, slots, images, applets, prompts, sessions UI
  public/css/              # Tailwind input/output
  public/lib/chart.min.js  # Chart.js v4 static bundle (served at /lib/chart.min.js)
extension/                 # Lumispec Browser Search Chrome extension (MV3, load unpacked) — see extension/README.md
data/                      # Runtime data dir: saved files, prompts.json, sessions.json, tasks.json (served at /files/)
  plugins.json             # Plugin enable/disable config (auto-created on first toggle, gitignored)
  pinned/                  # Pinned conversation JSON files (<id>.json)
logs/                      # Tool call logs (tools_YYYY-MM-DD.log)
test/                      # node --test suites (npm test); obsidian.test.js covers the exporter
```

## API Routes
| Route | Method | Description |
|---|---|---|
| `/api/conversations` | GET | List conversation summaries |
| `/api/conversations` | POST | Create conversation |
| `/api/conversations/:id` | GET | Get conversation with messages |
| `/api/conversations/:id` | PATCH | Update title |
| `/api/conversations/:id` | DELETE | Delete conversation + release slot |
| `/api/conversations/:id/messages` | POST | Send message, streams SSE response |
| `/api/conversations/:id/pin` | POST | Pin conversation (persist to disk) |
| `/api/conversations/:id/unpin` | POST | Unpin conversation (remove from disk) |
| `/api/conversations/:id/compact` | POST | LLM summarizes conversation, replaces messages with summary |
| `/api/conversations/:id/obsidian` | POST | Save conversation to the Obsidian vault (manual, pinned or not); body `{ color? }`; 400 plugin off, 409 no vault |
| `/api/conversations/:id/confirm` | POST | Approve/deny pending command (run_command tool) |
| `/api/conversations/:id/refine` | POST | LLM-powered prompt refinement from reasoning trace |
| `/api/conversations/:id/decompose` | POST | Taskmaster: LLM decomposes prompt into task list |
| `/api/conversations/:id/tasks` | POST | Execute task pipeline (SSE streaming) |
| `/api/conversations/:id/task-review` | POST | Continue or retry a paused pipeline step |
| `/api/slots` | GET | Slot status enriched with conversation mapping |
| `/api/slots/pin` | POST | Pin conversation to slot |
| `/api/slots/unpin` | POST | Unpin conversation from slot |
| `/api/health` | GET | llama-server health proxy |
| `/api/health/internet` | GET | Internet connectivity check (1.1.1.1) |
| `/api/health/search` | GET/POST | Search engine availability check / switch engine |
| `/api/health/liteapi` | GET | LiteAPI key validation |
| `/api/etrade/status` | GET | E*TRADE auth status |
| `/api/etrade/auth` | GET/POST | Start/complete OAuth flow |
| `/api/etrade/disconnect` | POST | Clear E*TRADE tokens |
| `/api/prompts` | GET/POST | List/create prompts (titles auto-generated by LLM) |
| `/api/prompts/:id` | PATCH/DELETE | Update/delete prompt |
| `/api/prompts/reorder` | PUT | Reorder prompts |
| `/api/sessions` | GET/POST | List/upsert session prompts (one per color, LLM titles) |
| `/api/sessions/:id` | PATCH/DELETE | Update title/text / delete session prompt |
| `/api/sessions/reorder` | PUT | Reorder sessions |
| `/api/templates/:id` | PATCH/DELETE | Update name / delete template |
| `/api/templates/:id/optimize` | POST | LLM-powered template optimization |
| `/api/templates/reorder` | PUT | Reorder templates |
| `/files/*` | GET | Serve project directory files (SOURCE_DIR) |
| `/api/config` | GET | Public config (location) |
| `/api/plugins` | GET | List configurable plugin groups |
| `/api/plugins/:group/toggle` | POST | Hot-load/unload a plugin group |
| `/api/plugins/:group/action/:id` | POST | Run a plugin card helper button (e.g. `browser` → `open-extensions`, `open-folder`) |
| `/api/tools` | GET | List tools with enabled status |
| `/api/tools/:name/toggle` | POST | Enable/disable a tool |
| `/api/tasks` | GET/POST | List/create tasks (saved task lists) |
| `/api/tasks/:id` | PATCH/DELETE | Update/delete task |
| `/api/tasks/reorder` | PUT | Reorder tasks |

## Commands
- `npm run dev` — start dev server with --watch
- `npm start` — start production server
- `npm test` — run `node --test` suites under `test/` (no server, no llama needed)
- `npm run css:build` — build Tailwind CSS
- `npm run css:watch` — watch & rebuild Tailwind CSS

## Environment Variables (via .env, required)
- `PORT` — server port (default: 3000)
- `LLAMA_URL` — llama-server base URL (default: `http://localhost:8080`)
- `LLAMA_MAX_CONTEXT` — fallback max context tokens (default: 131072). Only used when `/slots` is
  unreachable; the live slot `n_ctx` wins otherwise. Keep it at or below llama-server's
  `--ctx-size` — a value above the true window makes the tool loop skip its wind-down
- `MAX_PREV_RESULT_CHARS` — chars of the previous step's output a task-pipeline step receives
  (default: 32000). Absolute, not derived from `n_ctx` — raising `--ctx-size` does not raise it
- `SEARCH_ENGINE` — `keiro`, `tavily`, or `both` (default: `keiro`)
- `TAVILY_API_KEY` — Tavily search API key
- `KEIRO_API_KEY` — Keiro search API key
- `KEIRO_BASE_URL` — Keiro API base URL (default: `https://kierolabs.space/api`)
- `PYTHON_VENV` — path to Python venv for `run_python` tool
- `LITEAPI_KEY` — LiteAPI hotel/travel API key
- `ETRADE_CONSUMER_KEY` / `ETRADE_CONSUMER_SECRET` — E*TRADE OAuth credentials
- `ETRADE_SANDBOX` — `true` for sandbox mode
- `LOCATION` — default user location for weather/travel queries and `{$location}` macro
- `SOURCE_DIR` — project root path for source tools (self-awareness + code editing)
- `SOURCE_TEST` — test command for `source_test` tool (e.g. `npm test`, `pytest -x`, `cargo test`)
- `BROWSER_SEARCH_TOKEN` — optional shared secret the Browser Search Chrome extension must send as `?token=` on `/ws/browser`
- `BROWSER_SEARCH_TIMEOUT_MS` — how long `web_search`/`web_fetch` wait for the extension before falling back (default: 25000)
- `BROWSER_SEARCH_BROWSER` — optional executable the Browser Search card's "Open chrome://extensions" button launches (default: first of google-chrome, chromium, brave-browser, microsoft-edge on PATH)
- `OBSIDIAN_VAULT` — optional vault path for Obsidian export; overrides the card's vault pick and the registry lookup (vault on a share, or a machine without Obsidian)

## Tool System
Prompt-based tool calling: system prompt defines `<tool_call>` protocol. Backend loops up to 20 rounds executing tools and feeding results back until LLM produces a final answer. Tool-call rounds stream content as `{tool_content}` SSE events for user feedback. Final answer sent as `{content}` SSE event.

### Plugin Architecture
Tools are organized as per-group plugins in `src/tools/plugin-*.js`. Each plugin is a self-contained ES module auto-discovered by `loadPlugins()` at startup. The core index (`src/tools/index.js`) handles registration, system prompt assembly, parsing, execution, logging, and confirmation. `src/services/tools.js` is a backward-compat barrel that re-exports everything from `../tools/index.js`.

**Plugin Configuration**: Configurable plugins (source, travel, finance, wiki) can be hot-loaded/unloaded at runtime via the Plugins panel in the UI. Config persisted to `data/plugins.json` (gitignored, auto-created). Always-on plugins (`core`, `execution`) are not shown in the config UI. Each plugin exports optional `label` and `description` fields for the UI. `GET /api/plugins` lists configurable groups with tool names, descriptions, and dependency relationships. `POST /api/plugins/:group/toggle` hot-loads/unloads a plugin and persists the change.

**Plugin Dependencies**: Plugins can declare cross-group dependencies via an optional `dependencies: ['groupA', 'groupB']` field. Dependencies cascade **in both directions**:
- **At startup** (`loadPlugins()`): the dependency closure of all enabled plugins is computed and missing deps are auto-enabled in `data/plugins.json` so the system always converges to a consistent state.
- **On enable** (`updatePluginConfig`): enabling a plugin transitively enables all declared deps. Response includes `cascadedOn: [...]` listing newly-enabled groups so the UI can surface them in a toast.
- **On disable** (`updatePluginConfig`): disabling a plugin transitively disables all currently-enabled plugins that depend on it. Response includes `cascadedOff: [...]` listing newly-disabled groups. The toast discloses what was disabled and tells the user to re-enable the dependent (not the dependency) if they want both restored.

**Cascade asymmetry on recovery**: cascade-enable walks UP the dep graph (toward dependencies), cascade-disable walks DOWN (toward dependents). They are NOT inverses. If you disable `source` (which cascade-disables `wiki`) and then re-enable `source`, `wiki` does NOT auto-restore — you'd have to enable `wiki` manually (which would in turn cascade `source` back on if it were off). The recovery path is "enable the dependent, not the dependency."

**Plugin Supersession**: a plugin can declare `supersedes: ['web']`. In the Plugins panel it is listed directly after the last group it supersedes (otherwise cards follow plugin-file scan order). While it is enabled the listed groups are hot-unloaded (so it can re-register their tool names, e.g. `web_search`), `GET /api/plugins` reports them with `supersededBy: [...]`, and the panel grays their slider out at its *saved* position with a "Replaced by …" note. Toggling a superseded group via the API returns an error. The superseded groups' entries in `plugins.json` are never modified: disabling the superseder re-registers every superseded group whose saved config is still enabled. Toggle responses carry `superseded: [...]` / `restored: [...]` for the toast. At startup, superseded groups are dropped from the enabled closure after cfg is written. `browser` (`supersedes: ['web']`) is the only consumer.

**`defaults.enabled`**: with no entry in `plugins.json`, a plugin with `defaults: { enabled: false }` stays off until the user turns it on. Plugins without `defaults` are on by default (backward compatible).

**Generic card fields**: besides `modes`/`availableEngines`, `configUi()` may return `fields: [{ key, label, type: 'select'|'text'|'boolean'|'number', options?: [{value,label}], placeholder?, note?, disabled?, min?, max?, step?, group?, value? }]`. The panel renders them under the slider as one grid per card (label · control, the note on a full-width line beneath), so controls align whatever the label lengths; each change POSTs `/api/plugins/:group/toggle` with `{ config: { [key]: value } }` — to the card's own group, or to `group` when the field edits another group's entry, in which case `value` supplies the current value (config-only updates to a superseded group are allowed). `updatePluginConfig()` accepts only keys declared in the plugin's `defaults` (never `enabled`/`mode`/`engines`) and coerces each to the declared type. `getPluginConfig(group)` returns saved config merged over defaults. `obsidian` is the first consumer (vault select, folder text, two booleans). **Fetch cap**: `web.fetchMaxChars` (default `FETCH_MAX_CHARS` = 4000 — the pre-2026-10-31 fixed value — clamped to 1000–50000 by `getFetchMaxChars()`) is the markdown handed to the model per `web_fetch`; `fetchMaxCharsField()` renders it on both the Web Search & Fetch and Browser Search cards (`beforeCard` refreshes the value for the sync descriptor), and both fetch paths pass it to `htmlToMarkdown(html, url, { maxChars })` / `visibleText(html, cap)`.

Load-time validation runs DFS three-coloring to detect circular dependencies and warns on missing deps. Always-on groups can be listed as deps but are no-ops. The `wiki` plugin is currently the only consumer (`dependencies: ['source']`) — `source_read` is required for the wiki retrieval pattern.

#### Plugin Interface
Each `plugin-*.js` exports a default object:

```javascript
export default {
  group: 'mygroup',                              // group name (unique, used in toolGroups registry)
  label: 'My Plugin',                            // human-readable name for Plugins config UI (optional)
  description: 'What this plugin does.',         // short description for Plugins config UI (optional)
  dependencies: ['source'],                       // optional: group names this plugin requires; cascades on enable, blocks disable
  supersedes: ['web'],                            // optional: groups hot-unloaded (slider grayed) while this plugin is enabled
  cardStatus: () => ({ ok: true, text: '…' }),    // optional: live status line on the Plugins card (green when ok, amber otherwise)
  cardActions: () => null | { title, steps: ['…'], path?, buttons: [{ id, label, title?, copy? }] }, // optional: helper box under the status line; a button with `copy` copies that text client-side, any other POSTs /api/plugins/:group/action/:id
  cardAction: async (id) => ({ ok, message }),    // optional: runs a cardActions button server-side; works while the plugin is disabled
  beforeCard: async () => {},                     // optional: awaited by listPluginGroups() before cardStatus/configUi so sync hooks can see fresh config
  enableWarning: () => null | 'string',           // optional: warning toast shown right after the user enables the plugin
  defaults: { enabled: false },                   // optional: per-plugin config defaults; enabled:false = off until the user turns it on
  condition: () => someCheck(),                   // optional: group only active when true (omit for always-on)
  routing: ['- Question type → use "my_tool"'],   // LLM routing hints (array of strings, optional; or a sync function returning them, resolved per prompt build from cached state)
  prompt: '## My Section\n- Rule 1\n- Rule 2',   // system prompt section injected when group active (optional; or a sync function — Browser Search adds Tab Fetch lines only while the toggle is on)
  tools: {
    my_tool: {
      description: 'What this tool does. First line shown in tool list.',
      parameters: { param1: 'string', param2: 'number' },
      execute: async (args, context) => {
        // args = parsed arguments from LLM
        // context = { conversationId, sendSSE, autorun } (from conversations.js)
        return { result: 'data' };  // returned object is JSON.stringify'd and sent to LLM
      },
    },
  },
};
```

#### Creating a New Plugin

1. Create `src/tools/plugin-mygroup.js` with the interface above
2. Restart the server — `loadPlugins()` auto-discovers all `plugin-*.js` files (sorted alphabetically)
3. No changes needed to routes, index, barrel, or any other file

**Key details:**
- `group` must be unique across all plugins
- `dependencies` (optional array of group names) — declares cross-group requirements. Validated at load time (cycles → error, missing deps → warning). Cascade-enables on toggle; blocks disable if any enabled plugin depends on this one. Always-on groups in the list are no-ops.
- `condition` is re-evaluated on each message (dynamic activation, e.g. auth state)
- `routing` lines are merged into the "Tool Routing" system prompt section
- `prompt` is injected into the system prompt when the group is active (has enabled tools + condition met)
- `tools` object: each key is the tool name, value has `description`, `parameters`, and `execute`
- `execute` receives `(args, context)` — `context` has `conversationId`, `sendSSE()` for streaming status, and `autorun` flag
- Return plain objects from `execute` — they're auto-stringified. Use `_markdown` key for rich frontend display, `_diff` for diff previews, `_images` for base64 image data (all stripped from LLM context, sent to frontend via SSE)
- Tools are automatically available in the tool list, system prompt, and toggle API

**Shared helpers** (import from `../tools/index.js`):
- `fixPythonBooleans(code)` — convert JS-style booleans/null to Python equivalents
- `tagLineCount(stdout, limit)` — truncate output + append line count annotation
- `logToolCall(name, action, data)` — write to daily log file in `logs/`
- `requestConfirmation(conversationId, command)` — queue-based user approval (returns Promise<boolean>)

**Cross-group warnings** (e.g. "NEVER use etrade for travel") are handled in `getSystemPrompt()` in the core index, not in individual plugins.

#### Tool Groups

| Group | Plugin | Tools | Condition | Dependencies |
|---|---|---|---|---|
| `core` | plugin-core.js | `current_datetime` | — | — |
| `web` | plugin-web.js | `web_search`, `web_fetch` | — | — |
| `execution` | plugin-execution.js | `run_python` | — | — |
| `source` | plugin-source.js | 8 source tools + `template_save` | `config.sourceDir` set | — |
| `travel` | plugin-travel.js | `hotel`, `travel`, `booking` | — | — |
| `finance` | plugin-etrade.js | `etrade_account` | `etrade.isAuthenticated()` | — |
| `wiki` | plugin-wiki.js | `wiki_scan`, `wiki_index` | `config.sourceDir` set | `source` |
| `browser` | plugin-browser.js | `web_search`, `web_fetch`, `browser_tabs` (via Chrome extension) | off by default; supersedes `web` | — |
| `obsidian` | plugin-obsidian.js | `obsidian_export` | off by default | — |

`isToolGroupEnabled(name)` exported for runtime checks in `conversations.js`.

#### Browser Search (Chrome extension bridge)
`extension/` is a Manifest V3 extension loaded unpacked (install/remove guide in `extension/README.md`). It keeps a WebSocket to `ws://localhost:PORT/ws/browser`, served by `src/services/browserBridge.js` on the main Express server (attached in `server.js`, live whenever the server runs, loopback only, optional `BROWSER_SEARCH_TOKEN`). **The extension is engine-agnostic**: its only request type is `fetch { url, settleMs?, retryDelays? }` — it opens the URL in an **inactive** tab of the user's real Chrome, waits `settleMs` (default 0.8 s), probes the live DOM, re-probes after each `retryDelays` entry (default +3 s, +4 s) while the page is still a bot-challenge shell ("enable JS", "just a moment", …) or has under 200 chars of text, and once it has real text keeps probing every 0.6 s (up to 6 s) until the visible text stops growing and at least 10% of the DOM text is on screen (`domChars`; Gmail holds a ~450-char loading shell for seconds while the inbox rows sit hidden in the DOM) (progressive apps such as Gmail paint their chrome first — 444 chars were accepted as final on 2026-10-31 — while server-rendered pages settle on the first probe). It then serializes the DOM **once, minus script/style/noscript/template/svg** (the server deletes those before reading; on Gmail and NYT they were 75–100% of the bytes, and Gmail's 1.9M chars of inline CSS used to swallow the whole 2M cap before the body), caps it at 4M chars, returns `{ title, url, html, htmlChars, text, textChars, wall, wallText, truncated, reads }` and closes the tab (`text` is `document.body.innerText`, the page as laid out on screen with hidden elements excluded, capped at 400K — or, when innerText covers under 10% of the readable DOM text (`domChars`, body text minus script/style/noscript/template), a style-walk substitute, since in an inactive tab Chrome skips layout for virtualized lists and Gmail's inbox reported 593 chars of innerText against 24K in the DOM: `visibleTextWalk()` drops subtrees whose computed style is `display:none` / `visibility:hidden` or `aria-hidden`, turns blocks into lines and joins each leaf table/grid row (no rows nested inside, so Hacker News's layout tables stay multi-line) onto one line capped at 240 chars, cells separated by ` · `; `textSource` says which, and the `_tier` string mentions the walk; the same share test drives the settle loop's "still painting" wait; it backs `web_fetch` `view: "text"` via `renderedText()` — one trimmed line per visual row, table cells joined with ` · `, consecutive repeats dropped — which turns a Gmail inbox row from ~500 chars of markdown (tooltips, accessibility labels, star/emoji image links) into one ~100-char line; an extension older than v0.6.0 sends no `text`, so the server approximates with `visibleText()` and the result's `note` asks for a reload). One hidden tab at a time; a newer extension connection replaces the old one; liveness via protocol-level ping/pong every 30 s. It needs reloading only when `extension/` itself changes; the card flags a connected extension whose version differs from `extension/manifest.json`.

**All engine knowledge is server-side** in the `ENGINES` table of `plugin-browser.js`: per engine a `url(query)`, render waits (`settleMs`/`retryDelays` — Brave is client-rendered and gets more), a `block(page)` check for that engine's CAPTCHA/consent pages, and a linkedom `parse(page, limit)`. DuckDuckGo's parser is `parseDdgHtml()` shared with `plugin-web.js`. Adding an engine = one table entry; it appears on the card via `configUi()` automatically. `configUi()` sets `engineMode: 'single'`, so the panel renders the engines (`duckduckgo`, `brave`, `bing`, `google`) as radios: exactly one is active, saved as a one-element `engines` array. There is no chaining between browser engines (results are never merged); if the engine fails or returns nothing — CAPTCHA/consent detected server-side, parser drift — the call goes straight to the HTTP fallback. `plugin-browser.js` supersedes `web`. **Fallback with disclosure**: if no extension is connected, the request times out, every engine fails, or a fetched page yields under 200 chars *and Chrome itself saw under 500 chars of visible text*, the call runs `runWebSearch()` / `runWebFetch()` exported from `plugin-web.js` (the saved Web Search & Fetch settings, untouched by supersession) and the result carries `fallback: "<reason>"` plus a `sources`/`_tier` suffix, so the Think stream shows what happened. A rendered page the extractor cannot read (under 200 chars of markdown) is saved to `logs/browser-debug/fetch-thin-*.html`; if Chrome reported ≥500 chars of visible text (`REAL_PAGE_MIN_TEXT`) the call returns that visible text via `visibleText()` (one line per block, same cap as markdown — `web.fetchMaxChars`, default 4000, configurable since 2026-10-31 — `note` says it is not an extracted article) and **never falls back** — the HTTP tier has no browser cookies, so re-fetching a signed-in page hands the model a login screen (Gmail, 2026-10-31). Otherwise the fallback reason names the file, the visible text count and whether the 4M-char cap truncated the page. Challenge pages rendered inside a cross-origin iframe (DataDome `captcha-delivery.com`, Cloudflare, hCaptcha, reCAPTCHA, PerimeterX, Arkose) leave the main document with no text, so `detectWall()` also checks iframe `src`/`title` on thin pages and names the vendor (Reuters → DataDome, 2026-10-31). The card has a **Save every fetched page** boolean (`dumpPages`): while on, every extension fetch is written to `logs/browser-debug/fetch-<host>-*.html` for extractor work (`fetch-thin-*` dumps cover only pages the extractor failed on outright). Any HTTP fallback result that reads like a sign-in page (`looksLikeLoginPage()`: short content with sign-in / guest-mode / password phrasing) carries `loginWall: true` and a `note` stating it is not evidence the user is logged out, with the title Chrome reached when there was one. `htmlToMarkdown(html, url)` strips `<template>` elements before Readability scores the page and falls back to the whole body when Readability's pick renders as empty (the NYT homepage embeds a 100K-char interactive in a `<template>`, which used to come out as 0 chars). **Index pages** (homepages, section fronts, date archives) are detected generically — headline-length link text (≥25 chars) is at least 20% of the page text, under 30% of those links survive in Readability's output, and Readability kept under 70% of the page text (index pages measured 3–46%, a summary-rich fixture 60%; article pages 76–94%) — and rendered by `renderLinkIndex()` as `- [headline](absolute url) — summary` lines under an `Index page: N linked stories.` header, because Readability prunes link-wrapped headlines as "related links" and returns summaries with every headline missing (NYT and Guardian measured 0 kept). Article pages measure 2–6% link text with 80–90% kept and are untouched; homepages Readability already reads well (BBC, Guardian front, HN) keep 51–96% of their links and stay on Readability. The share bound started at 30% and Reuters straddled it (0.31 / 0.24 across renders of the same page, 0 of 90 headlines kept either way), hence 20% plus the text-kept guard. The status dot "Browser" is green when the extension is connected, amber otherwise; the Plugins card shows a live `cardStatus` line (connected + version / disconnected + last seen / never connected + install pointer) and enabling with no extension connected raises an `enableWarning` toast. The viewer's own browser is never checked: the UI may run in Firefox while the extension runs in Chrome on the same machine. **Install helper**: while no extension is connected (or the connected one is outdated) the card shows a `cardActions` box — numbered steps, the absolute `extension/` path, and buttons **Open chrome://extensions** (server spawns the first Chromium-family binary on PATH, or `BROWSER_SEARCH_BROWSER`, detached with the URL; a running Chrome opens it as a new tab), **Open extension folder** (`xdg-open`/`open`/`explorer`, for drag-and-drop onto the extensions page) and **Copy path** (client-side clipboard). Fully automatic install is impossible: web pages cannot navigate to `chrome://`, and branded Chrome 137+ ignores `--load-extension`, so Developer mode + Load unpacked remain the user's two clicks. While the Plugins panel is open the frontend re-fetches `/api/plugins` every 4 s and re-renders only when a live field (`cardStatus`, `cardActions`, enabled, `supersededBy`) changed, so the card turns green and drops the guide the moment the extension connects, with a toast. Plugins declare their panel controls via `configUi()` → `{ modes?, availableEngines? }`; the `web` plugin uses both, `browser` only engines.

**Tab Fetch** (design and plan in `docs/TAB_FETCH.md`): the user prepares a page by hand — login, two-factor, a passed CAPTCHA, filters, scrolling — and the model reads **that tab in place**. Opt-in: four booleans on the card (`readTabs` master switch off by default; `confirmTabReads` on; `reuseOpenTab` on; `protectOpenSites` off). Extension ≥ 0.7.0 advertises `capabilities: ['fetch','tabs','read']`; `tabs` lists the user's open web tabs (the extension's own transient tabs are tracked in `ownTabs` and never listed or readable; incognito and `chrome://` excluded; `current` = active tab of the focused window; `lastAccessed` is Chrome 121+), `read { tabId }` runs `extractPage` in that tab with no navigation, reload, activation or close (`tabs.update/remove/windows.*` are never called on user tabs). Server: `browser_tabs` tool (returns `tabs`, `current`, `activeIsLumispec`, a `_markdown` table) and `web_fetch { tab }` → `readUserTab()`: `resolveTab(spec, tabs)` is pure — `"active"` (never the app's own `localhost:PORT`, `isAppUrl()`), a numeric id, or a case-insensitive host-suffix / title / URL substring that must match **exactly one** tab, else `{ error, candidates }` so the model asks (two Chase tabs → ask; "bank" with BofA and Chase open → ask). `confirmTabReads` goes through `context.confirmFn` naming the tab; **autorun does not bypass it** (same stance as `source_project`); no `confirmFn` → error. A tab read never falls back to HTTP; results carry `source: 'tab'`, `tab: { id, title, host, current, lastAccessed }`, `_tier: 'extension (your open tab, read in place, N ms)'`, and both views work (`text` is exact there: the active tab has layout). **Host care on hidden fetches** (`hostCarePlan(url, tabs, cfg)`, pure; only when `readTabs` is on): same address already open (`normalizeUrlForReuse()`: www/trailing slash/`utm_*` etc. dropped, hash and other params kept) → `fetch { reuseTabId }` reads that tab (`reused`, `source: 'tab'`, note) **without the approval prompt**, since a hidden fetch would have loaded the same address with the same cookies and disclosed the same content; same host, other address → hidden fetch proceeds with `openTabs` + `hint` attached; `protectOpenSites` → `{ error, openTabs }` and stop. With `readTabs` off every hidden fetch is byte-for-byte the v1.4.2 hidden fetch (plus the text view). `prompt`/`routing` are functions reading `tabCfgCache` (refreshed by `beforeCard()` and every tab tool call), so the Tab Fetch guidance appears in the system prompt only while the toggle is on; `cardStatus` appends "· Tab Fetch on" or asks for a reload when the extension lacks the capability. Tests: `test/tabFetch.test.js` (resolution, host care, read flow with a fake bridge), `test/browserBridge.test.js` (fake extension over a real WebSocket).

Safety mechanisms:
- Max 3 identical tool call repeats (same name+args signature), then tool is disabled
- Max 4 parallel tool calls per round (excess dropped)
- Bare/malformed JSON tool calls trigger retry prompts (skipped when response contains `<applet>` blocks). `MAX_REPAIR_ROUNDS` (3) caps consecutive retries: the loop then breaks to the forced answer with a "your last N tool calls were never executed" instruction instead of burning the remaining rounds (route log `end`/`repair-limit`)
- Parser key normalization (`normalizeToolCallKeys`): accepts `"function"`/`"tool_name"`/`"tool"` as the name key and re-quotes keys that lost their opening quote (`,\narguments": {`), both seen from Qwen3.8 on 2026-10-29
- Safety net catches unparsed tool calls in final content (also skipped for applet responses)
- Options-analysis continuation: forces optionchains call if LLM stops after fetching expiry data (finance group only)
- Fabrication detector: catches LLM presenting Greeks/prices without fetching data (finance group only)
- Tool call logging to `logs/` directory
- Queue-based command confirmation: parallel calls confirmed FIFO (not single-slot)
- Truncated tool call repair: extracts partial code/command from incomplete JSON instead of failing
- run_python auto-fixes: Python booleans (`fixPythonBooleans`), backslash+newline double-escaping in string literals
- Context budget: `MAX_TOOL_ROUNDS` bounds rounds, this bounds tokens — see **Context Budget** below

#### Context Budget
Every tool round appends its results to the LLM message array, so a long tool run walks the prompt
into the slot's context wall. llama-server does **not** error there — it returns HTTP 200 with
`finish_reason: "length"` and an empty message, which used to surface as a blank assistant bubble
with the whole turn discarded (see `OVERFLOW.md`).

Both tool loops (`conversations.js`, `taskProcessor.js`) now measure the real prompt at the top of
every round via `countPromptTokens()` and wind down at 80% of the slot's `n_ctx`:
- `trimOldToolResults()` shrinks the oldest tool results to 400 chars, keeping the newest 3 intact
- a `{tool_status}` SSE event announces the wind-down
- an "answer now, no tools" instruction is injected and **that round becomes terminal** — tool calls
  in it are logged and ignored, since there is no room to feed results back in

`countPromptTokens()` (`src/services/llm.js`) calls llama-server's `/tokenize` — accurate to ~0.1%,
~78ms for a 64K prompt, with a `chars / 3.5` fallback. It does **not** use `timings.prompt_n` from
the completion response: that is the number of tokens actually *processed*, which with KV cache
reuse reads 37 for a 64K prompt and would never see the wall coming.

The limit comes from the live slot (`slots.getSlotContextSize()`), so raising `--ctx-size` raises
the budget with no code change. `LLAMA_MAX_CONTEXT` is only the fallback when slots are unreachable.
`countPromptTokens()` also counts `reasoning_content` on assistant messages (see **Retain Toggle**).

**Context bar shows measured context, not timings totals.** `tokenCount` (and the `usage` SSE event's
`context_tokens`) is the last round's `countPromptTokens()` result plus that round's
`completion_tokens` — what the slot holds after the turn. It is **not** `timings.total_tokens`:
`prompt_n` counts tokens *processed*, so with KV-cache reuse the bar read ~80 after a cached turn.
The task pipeline reports the **last step's** context (steps are isolated) and `peak_context_tokens`
alongside; `total_tokens` there is still the sum of all steps and rounds — a measure of work, which
is why the bar used to show 84K on a 64K slot.

**Empty / truncated answers are never silent:**
- `finish_reason: "length"` with content → a "⚠ Answer cut off at the context limit" marker is appended
- empty final content in chat → stored as `[Error: Empty response after N tool call(s)…]` and sent as
  an `{error}` event, with `toolUses` and `reasoning` kept on the message so the work stays on screen
- empty step output in the pipeline → returned as a step error, so the run stops with `{task_error}`
  instead of handing the next step an empty context (a step's output is the next step's only context)

### Registered Tools
| Tool | Description |
|---|---|
| `current_datetime` | Returns UTC, local time, IANA timezone, UTC offset |
| `web_search` | Web search via Keiro and/or Tavily (configurable) |
| `web_fetch` | Fetch URL. `view: "article"` (default) extracts the article or, on a front page, the headline-link list as markdown (Readability + Turndown); `view: "text"` returns the page as it reads on screen, one line per visual row — Chrome's `innerText` via the Browser Search extension (hidden labels and images excluded), approximated from markup on the HTTP tier (`note` says so). For web apps: mail, calendars, dashboards, boards. `tab: "active" | <id> | <host/title fragment>` reads one of the user's **open** tabs in place instead of loading a URL (Tab Fetch, Browser Search only; off by default) |
| `browser_tabs` | Lists the user's open web tabs (id, title, host, URL, current). Browser Search only, available while "Let the assistant read my open tabs" is on; the model calls it before `web_fetch { tab }`. One match reads; several → it must ask |
| `run_python` | Execute Python script in venv, cwd=SOURCE_DIR, 120s timeout. Auto-fixes Python booleans and newline escaping |
| `source_read` | Read app's own source code: tree (list files), read (file contents), grep (search). Scoped to SOURCE_DIR |
| `source_write` | Write/create source files. Path-escape protected, confirmation required. Scoped to SOURCE_DIR |
| `source_edit` | Targeted edits: exact string replacement with uniqueness check, whitespace fallback, diff preview, file locking. Scoped to SOURCE_DIR |
| `source_delete` | Delete source files (e.g. during refactors). Confirmation required. Scoped to SOURCE_DIR |
| `source_git` | Git commands with safety tiers: read-only (no confirm), local writes (confirm/autorun), remote (always confirm), destructive (blocked). cwd=SOURCE_DIR |
| `source_run` | Run shell commands in source project dir (e.g. python3 script.py, npm run build). Confirmation/autorun, 120s timeout |
| `source_test` | Run project test command (SOURCE_TEST env var). No params, no confirmation, 120s timeout. Language-agnostic |
| `source_project` | Switch source tools to a different project directory. Always requires confirmation. Actions: switch, reset, status |
| `etrade_account` | E*TRADE: accounts, portfolio, transactions, orders, alerts, quotes, option chains/expiry, symbol lookup |
| `hotel` | LiteAPI: hotel search, details, rates, reviews, semantic search |
| `travel` | LiteAPI: weather, places, countries, cities, IATA codes, price index |
| `booking` | LiteAPI: prebook, book, list bookings, booking details, cancel |
| `wiki_scan` | Walks both source markdown tree and `wiki/` tree, returns unified view: `fileEntries` (with compressed/stale flags via `last_updated:` frontmatter), `noteEntries`/`lensEntries` (reserved `_`-prefixed subdirs), `orphans`, `nextBatch` (capped at 20), and `hasMore` boolean. Recognizes `_notes/`, `_lens/<color>/`, `_conv/`, `_web/` as reserved non-file-derived areas. |
| `wiki_index` | Indexes a single markdown file: reads source, asks LLM to produce a YAML-frontmatter + paragraph + key-topics summary, plugin enforces correct `source: file:<path>` URI and `last_updated:` ISO timestamp via `enforceFrontmatterFields()`, writes to `wiki/<same-relative-path>`. Refuses paths colliding with reserved subdirs. `force: true` rebuilds existing entries. |

Tools can be toggled on/off at runtime via `/api/tools/:name/toggle`. Plugin groups can be hot-loaded/unloaded via the Plugins config panel (`/api/plugins/:group/toggle`).

### Applet System
Prompt-based interactive HTML visualizations rendered in sandboxed iframes within assistant chat bubbles. Not a tool — the LLM emits `<applet type="TYPE">` blocks in its final response content.

**Types**: `svg` (inline SVG), `chartjs` (Chart.js config-driven), `html` (plain HTML/CSS/JS)

**Toggle**: Checkbox in input form next to attach button. State in `state.appletsEnabled`, persisted to localStorage (default: on). Sent as `applets: true|false` in message POST body. Backend conditionally injects applet prompt section into system prompt via `getSystemPrompt({ applets })`.

### Autorun
Checkbox labeled "Autorun" next to the Applets checkbox. When enabled, `run_python`, `run_command`, and source tools (`source_write`, `source_edit`, `source_delete`, `source_git` local writes) skip the confirmation prompt and run immediately. Exception: `source_project` always requires confirmation regardless of autorun.

**Toggle**: State in `state.autorunEnabled`, persisted to localStorage (default: off). Sent as `autorun: true|false` in message POST body. Backend passes `autorun` flag in the tool execution context.

### Precision Mode
Checkbox labeled "Precision" next to Review. Enforces strict computation discipline: no mental math, all calculations via `run_python`, no rounding/fabrication of numerical data, vectorized pandas rules.

**Toggle**: State in `state.precisionEnabled`, persisted to localStorage (default: off). Sent as `precision: true|false` in message POST body. Backend injects `PRECISION_RULES` section into system prompt via `getSystemPrompt({ precision })`.

**Auto-activation**: When the finance group (E*TRADE) is active (`isToolGroupEnabled('finance')`), precision rules are always injected regardless of the toggle. This ensures financial data is never handled with mental math.

**Rule split**: Generic computation rules (data integrity, no mental math, pandas code quality, error handling) live in `PRECISION_RULES` constant in `src/tools/index.js`. E*TRADE-specific domain rules (options reasoning, position definitions, table formats, chain fetching workflows) stay in `plugin-etrade.js`.

### Stop Button
Red square icon button in the input area button column (below Send). Hidden by default, appears during streaming. Clicking aborts the `AbortController`, cancels the fetch, stops the elapsed timer, and re-renders messages from server data so regenerate buttons appear on user messages.

### Refine Button
Small "Refine" button on thinking/reasoning `<details>` blocks. Sends the original user prompt + reasoning trace to the LLM via `POST /api/conversations/:id/refine`. The LLM analyzes where it struggled or made assumptions and returns an improved prompt (max 3x original length). Result loaded into the input textarea for user review. Shows "Already optimal" if the prompt doesn't need improvement.

### Task Pipeline
Sequential LLM execution system for breaking complex multi-step workflows into discrete tasks with isolated context. Instead of one long prompt, each task runs independently and receives only the previous step's output.

**Two levels — structure declares intent:**

| Level | Syntax | Meaning | Context behavior |
|---|---|---|---|
| Top-level | `- task` | Dependent sequential step | Receives previous step's output (chaining) |
| Indented | `  - subtask` | Independent work under a group | Receives only the parent's incoming context (isolation) |

Indentation = independence, flat = chaining. No configuration needed.

**Flat tasks (chained):** Each step sees only the immediately preceding output. `Task 2` gets `Task 1`'s result. Context stays small.

**Nested tasks (isolated + merged):** Parent is a label (not executed). Subtasks execute sequentially with full isolation from siblings — all receive the same incoming context. After all complete, results are merged with section headers and passed downstream.

**Step context — three components:** Each step receives up to three pieces of context assembled into its user message, separated from the task prompt by `---`:

| Component | Flat task | Subtask | Scope |
|---|---|---|---|
| Task prompt (`taskText`) | The task's own text | The subtask's own text | Current step |
| Parent prompt (`parentText`) | — | Group label text (e.g. constraints, instructions) | Subtask group |
| Previous output (`prev.result`) | Immediately preceding task's output | Previous top-level task's output (same for all siblings) | Sequential, one step back |
| Previous files (`prev.files`) | Files saved by preceding task | Files from previous top-level task (same for all siblings) | Sequential, one step back |

Example pipeline: Task 1 → Task 2 → Task 3 (subtasks A, B) → Task 4

| Step | Task prompt | Parent prompt | prev.result | prev.files |
|---|---|---|---|---|
| Task 1 | "fetch AMD data" | — | *(none)* | *(none)* |
| Task 2 | "analyze the data" | — | Task 1 output | Task 1 files |
| Task 3 (group) | "visualize results" | — | *(not executed)* | — |
|   Subtask A | "chart prices" | "visualize results" | Task 2 output | Task 2 files |
|   Subtask B | "chart volume" | "visualize results" | Task 2 output | Task 2 files |
| Task 4 | "write summary" | — | merged A+B output | A+B files |

Key isolation rules:
- Subtasks never see sibling output or sibling files
- Files follow the same sequential scope as prev.result (not global/cumulative)
- Parent text is only injected for subtasks — flat tasks have their own text as the prompt
- The LLM never sees the full task list

Each step also gets a pipeline-aware system prompt addition (step number, "complete ONLY the current task" rules). Previous output framed as user message with "Previous Step Output" header (max 32K chars).

**Execution engine:** Each task/subtask runs through the same tool loop as regular chat (up to 20 tool rounds, repeat detection, parallel tool cap, context budget, confirmation flow, full SSE streaming).

**Empty step = pipeline halt:** A step that produces no output (context exhausted, or content stripped as a bare tool call) returns a step error instead of an empty result — the run stops with `{task_error}` naming the token counts and any files the dead step saved. A step's output is the next step's only context, so passing an empty one through would make every downstream step invent from nothing. This is the one place the pipeline loop deliberately diverges from the chat loop, which only reports and ends the turn.

**File exchange between steps:** Large tool results (option chains, etc.) auto-save to CSV files. Filenames passed to the next step via "Available Data Files" section in the user message (scoping described in table above).

**Review mode:** Review checkbox appears in input area when list mode is active. When enabled, pipeline pauses after each completed task (except last) with Continue/Retry buttons. Continue accepts output and proceeds. Retry discards output, restores context to pre-task state, and re-runs (fresh LLM call, may produce different output due to temperature). Backend emits `{task_review}` SSE event and pauses on a promise; frontend POSTs to `/api/conversations/:id/task-review` with `{action: "continue"|"retry"}` to unblock.

**Input — bullet list editing:** Activated by clicking bullet-list button or pasting a multi-line bullet list (auto-detected). Keyboard: Enter (new bullet), Tab (indent to subtask, max 1 level), Shift+Tab (outdent), Backspace on empty (outdent then remove), Ctrl+Enter (submit). In list mode: Save Prompt saves to Tasks menu (not Prompts); Save Session and Save Compact disabled.

**Storage:** Task runs stored as a single assistant message with `text` (backward-compatible markdown) and `taskRun` array (structured metadata with per-step results, tool uses, and reasoning). On re-render, `taskRun` drives structured display with per-step reasoning blocks, tool use details, and formatted content.

**SSE events:** `{task_start}` → `{subtask_start}` → (streaming events) → `{subtask_complete}` → `{task_complete}` → `{task_review}` (if enabled) → `{task_error}` (on failure, pipeline stops) → `[DONE]`

**Task list persistence:** Saved task lists stored in `data/tasks.json` via `src/services/tasks.js`. CRUD + reorder via `/api/tasks` routes. Tasks menu in top bar dropdown (alongside Prompts, Sessions, Templates) with same drag/edit/delete UI pattern.

### Taskmaster
Checkbox labeled "Taskmaster" (violet accent) in the input area. When enabled, user prompts are auto-decomposed into task pipeline lists before execution.

**Flow:** User types prompt → Submit → backend calls `POST /:id/decompose` (non-streaming LLM call, 30s timeout, 1024 max tokens, temperature 0.3) → LLM returns bullet list → frontend loads into textarea in list mode for user review/edit → user submits with Ctrl+Enter → runs through existing task pipeline.

**Single-task safeguard:** If the LLM returns ≤1 top-level task (simple request), the prompt is sent as a normal message — no pipeline overhead. Backend returns `{ tasks, single: true }`.

**Decomposition prompt:** `TASKMASTER_PROMPT` constant in `src/tools/index.js` (exported through barrel). Instructs LLM to output exact bullet list format the pipeline accepts. Includes:
- Flat vs nested rules: flat (top-level) = chained sequential steps; nested (indented) = independent work that merges
- Max 6 top-level tasks, max 5 subtasks per group
- "When NOT to split" rules (simple questions, single lookups, conversational)
- Context-isolation awareness: each task must be self-contained since it won't see the original request
- 5 few-shot examples covering flat, nested, single-task, and mixed patterns
- Tool-aware hints (knows available tools to split correctly)
- Anti-patterns: no meta-tasks ("understand", "plan", "summarize"), no request repetition

**Backend:** `POST /api/conversations/:id/decompose` in `src/routes/conversations.js`. Uses `collectChatCompletion` (same pattern as refine/title generation). Strips `<think>` blocks and code fences. Validates output contains bullets, falls back to single-task if not.

**Frontend:** `state.taskmasterEnabled` persisted to localStorage (default: off). Send button shows `⟳` during decomposition. On error, falls back to normal send. Images bypass taskmaster (sent as normal message).

**Toggle:** State in `state.taskmasterEnabled`, persisted to localStorage (default: off). Checkbox in input area after Precision.

### Think Toggle
Checkbox labeled "Think" next to Autorun. Controls visibility of reasoning/thinking blocks, tool content ("Working..."), tool status messages, and tool use details ("Used web_search", etc.) during streaming.

**Toggle**: State in `state.thinkEnabled`, persisted to localStorage (default: on). When off, only final response content is shown — all intermediate processing UI is suppressed.

**Session init behavior**: Think is temporarily disabled during session init prompts (auto-submitted when clicking a colored New Chat button), then restored to its previous state after the response completes.

### Retain Toggle
Checkbox labeled "Retain" next to Think. Think shows the model's reasoning; Retain sends it back. When on,
every assistant message handed to llama-server carries `reasoning_content`, which the Qwen chat template
renders as that message's `<think>` block. Default **off** — retained reasoning makes every prompt larger.

**Toggle**: State in `state.retainEnabled`, persisted to localStorage (default: off). Sent as
`retain: true|false` in both the message POST body and the task-pipeline POST body.

**What gets attached** (`asAssistant()` helper in `conversations.js` and `taskProcessor.js`):
- Tool-loop rounds: each round's assistant message carries **that round's own** reasoning, so the
  prompt prefix matches what the model generated and the KV cache can reuse it.
- History rebuild: each stored assistant message carries its stored `reasoning`, which is the whole
  turn's thinking concatenated across rounds (tool rounds are not replayed in history, so the final
  answer is the only message to attach it to).
- Task pipeline: reasoning stays inside a step. `prev.result` between steps is content only.
- The flag is read at send time: toggling off drops all prior reasoning from the next prompt.

**No server flag needed**: the Qwen3.8 template preserves reasoning for every assistant message when
`preserve_thinking` is undefined, and llama.cpp treats `--reasoning-preserve` as on by default. The
template reads only the `reasoning_content` field — it does not parse `<think>` tags out of `content`,
so inlining tags would produce a double think block.

**Context budget**: `countPromptTokens()` includes `reasoning_content`, so the 80% wind-down measures
the true prompt. Nothing else changes — retained reasoning just makes the wall arrive sooner.

**KV cache**: with Retain on, each re-sent assistant turn matches what the model generated, so the
slot's cached prefix extends through the whole history and a new turn processes only the new
question (~80 tokens measured vs ~780–1,100 when the toggle flips and the history is re-read). This
depends on the system prompt being stable — see the date/time bullet under **Key Architecture Details**.

**Claude backend**: `reasoning_content` is stripped in `mergeConsecutiveRoles()` before the request;
the Anthropic API rejects unknown message fields.

### Session System
Colored session types that define conversation categories. Each conversation is associated with a session color. Session prompts are saved per color and auto-submitted when creating a new chat.

**Session colors**: Defined as CSS variables in `:root` (`--btn-blue`, `--btn-cyan`, `--btn-amber`, `--btn-coral`, `--btn-sgreen`, `--btn-navy`, `--btn-lavender`, `--btn-purple`, `--btn-hotpink`, `--btn-sky`). Easy to change in one place.

**Session buttons**: 7 primary colored `+` buttons always visible in the top bar, plus 3 extra (purple, hot pink, sky) behind a `›`/`‹` expand/collapse chevron (state persisted to localStorage). Clicking creates a new conversation, assigns the color, and auto-loads/submits the matching session prompt (if saved).

**Session persistence**:
- `state.sessionColors` (localStorage `sessionColors`): `Map<convId, sessionType>` — per-conversation color assignment
- `state.currentConversationId` (localStorage `activeConversationId`): persists active conversation across refresh
- `data/sessions.json`: server-side session prompt storage (one per color, upserted)

**Session prompt behavior**:
- Auto-submitted with `hideUserMessage: true` — user message bubble hidden from chat
- Auto-title skipped for hidden session prompts (`hidden` flag in POST body)
- Title only set from first visible user message
- Variable substitution (`{$date}`, `{$time}`, `{$location}`, custom vars) supported via same modal as prompts
- Think toggle temporarily disabled during session init

**Input locking**: Input textarea and Send button disabled when no session is active (`!currentConversationId || !sessionType`). Placeholder shows "Select or create a session to start…". Menu items (Sessions, Prompts, Templates) also blocked without active session — clicking shows red "Create a session first" flash message inline with empty state text.

**Save Session button**: Saves input text as the session prompt for the current color. Upserts — same color overwrites existing (with overwrite confirmation dialog if a prompt already exists for the color). LLM generates title (defensive prompt with triple-backtick wrapping to prevent instruction following). Same overwrite confirmation applies to Save Compact button.

**Sessions menu**: Dropdown in top bar menu (Prompts, Sessions, Templates). Lists saved session prompts with titles colored by session color. Click to load text into input (with variable substitution). Drag grip handle (⠿) to reorder. Pencil (✎) button for inline title editing. Delete with hover ✕ button.

**Session button tooltips**: Colored `+` buttons show instant CSS tooltips on hover with the saved session prompt title (via `data-tip` attribute, no native title delay).

### Draggable Menus & Inline Editing
All three dropdown menus (Prompts, Sessions, Templates) share the same UI pattern:
- **Drag grip handle** (⠿): mousedown on grip enables `draggable`, drop reorders and persists via PUT `/reorder` endpoint
- **Inline title editing** (✎): `startTitleEdit()` makes title span `contentEditable`, Enter saves via PATCH, Escape cancels, blur saves
- **Click**: loads prompt/session text into input (with variable substitution) or inserts template tag
- **Delete** (✕): hover-visible delete button
- Items are NOT `draggable` by default — only grip handle enables it, preventing accidental drag on click
- Dropdowns expand up to `max-h-[80vh]` before scrolling

### Location Macro
- `LOCATION` env var exposed via `GET /api/config` endpoint
- Frontend fetches on init, stores in `state.location`
- `{$location}` builtin macro auto-expands like `{$date}` — no modal prompt
- Location also injected into LLM system prompt ("User Location" section) for weather/travel queries

### Source Code Development Tools
Full coding assistance suite scoped to `SOURCE_DIR`. All path-based tools enforce escape protection (resolved paths must start with `sourceRoot`). System prompt includes "Self-Awareness" section when `SOURCE_DIR` is configured.

**Tools:**
- `source_project`: switch all source tools to a different project directory at runtime. Always requires confirmation (never skipped by autorun). Actions: `switch` (with path + `~` expansion), `reset` (back to .env), `status`. Original dir saved at startup for reset.
- `source_read`: three actions — `tree` (list files, excludes node_modules/.git/data/logs), `read` (file by path, 15K char limit), `grep` (regex search, 50 match limit). No confirmation needed.
- `source_write`: create or overwrite files. Auto-creates parent dirs. Generates diff preview (new vs old content) shown in both confirmation and tool result.
- `source_edit`: targeted string replacement. Uniqueness enforced (error with match locations if >1). Whitespace fallback for indentation mismatches. Per-file mutex for concurrent safety. Diff preview in confirmation and result.
- `source_delete`: remove files (directories blocked). Shows file size in confirmation. Diff preview in result.
- `source_git`: git command runner with safety tiers — safe (status/diff/log/show/blame: no confirm), local writes (add/commit/branch/checkout/stash/merge/tag: confirm/autorun), remote (push/pull/fetch: always confirm), blocked (reset --hard, push --force, clean -f, rebase).
- `source_run` tool: run any shell command in source project dir (e.g. `python3 script.py`, `npm run build`), confirmation/autorun, 120s timeout
- `source_test`: runs `SOURCE_TEST` env var command in source dir. No parameters, no confirmation needed, 120s timeout. Language-agnostic (npm test, pytest, cargo test, etc.).

**Diff preview system:** `source_write`, `source_edit`, and `source_delete` include `_diff` field in results. Frontend renders color-coded diff blocks (green=added, red=removed, cyan=hunk headers). `_diff` stripped from LLM context to save tokens. Diffs shown in both confirmation prompt and tool_use display (visible even with autorun).

### Elapsed Timer
- Live timer in top bar next to context label, starts on `sendMessage()`, stops in `finally` block
- Updates every second: `0s`, `1s`, ... `1m 23s`
- Stays visible with final time after response completes

**Frontend rendering** (app.js):
- `extractApplets(text)` — regex-extracts `<applet>` blocks (single or double quotes on `type` attr) BEFORE DOMPurify (which strips deprecated `<applet>` tags), replaces with `<div data-applet="N">` placeholders that survive marked.parse + DOMPurify
- `createAppletIframe(applet)` — builds sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`), auto-injects Chart.js for `type="chartjs"`, auto-injects resize script (ResizeObserver + image load listeners + MutationObserver), validates content (`type="html"` always valid; others must contain `<script>`/`<svg>`/`<canvas>`), enforces 50KB cap, falls back to collapsible code block
- `renderFormattedContent()` — calls extractApplets first, runs cleaned text through marked+DOMPurify, then replaces placeholders with iframes
- Global `message` listener for iframe resize (100-20000px height cap, scroll fallback when exceeded). Height guards on both sides (iframe skips postMessage, parent skips style update) to prevent feedback loops
- Streaming safety: partial renders (`scheduleRender` → `renderFormattedContent(…, { partial: true })`) only match fully closed applets, so a half-streamed block renders as text. The **final** render uses the tolerant `APPLET_RE` (`(?:<\/applet>|$)`), which also accepts a block whose closing tag is missing or cut short at the very end of the text, and strips the leftover `</applet` prefix. 2026-10-31: a 19K dashboard ended in `</applet` because the model sampled end-of-sequence instead of the final `>`; the strict regex matched nothing and the HTML rendered as sanitized markdown. `src/services/applets.js` is the server-side definition (`APPLET_RE`, `appletBody()`, `replaceApplets()`), used by the history filter and the Obsidian exporter; app.js carries a copy.

**Context management** (conversations.js): Assistant messages in history have `<applet>...</applet>` blocks replaced with `[Applet: TYPE visualization]` before sending to LLM (via `replaceApplets()` from `src/services/applets.js`, tolerant of a missing closer at the end of the text), preserving stored content for frontend re-rendering.

**Chart.js**: Served as static file from `src/public/lib/chart.min.js` at `/lib/chart.min.js` — no CDN dependency.

**Security**: `sandbox="allow-scripts allow-same-origin"` allows JS execution and fetch to same-origin `/files/` endpoints. postMessage resize is the parent communication channel.

### Template Sanitizer & Optimizer
**Sanitizer** (`sanitizeTemplate()` in `src/routes/templates.js`): Runs automatically on POST and PATCH. Fixes Python-in-JS (None→null, True→true inside `<script>` blocks only), CDN→local Chart.js, stray semicolons. Deterministic, no LLM.

**LLM Optimizer** (`POST /api/templates/:id/optimize`): Sends template HTML to LLM with optimization prompt. Fixes: hardcoded data → fetch from `/files/`, empty selects → dynamic population, missing error handling, missing resize postMessage. Frontend ⚡ button in Templates dropdown, disables after success.

### File Serving
Project directory files served at `/files/` via dynamic Express middleware (follows `source_project` switches). Applets fetch data from `/files/FILENAME`. run_python writes to cwd (SOURCE_DIR) — files are automatically available at `/files/`. `/files/` is a read URL, not a filesystem write path.

### Click-to-Copy
Clicking any word in an assistant message bubble appends it to the input textarea. Uses `caretPositionFromPoint`/`caretRangeFromPoint` for precise word detection. Skips text selection and non-assistant bubbles.

## SSE Event Types
The `/api/conversations/:id/messages` endpoint streams these SSE events:
- `{reasoning}` — reasoning/thinking tokens (Qwen3 `reasoning_content`)
- `{tool_content}` — streamed content during tool rounds (user sees progress)
- `{tool_use}` — completed tool call with name and result
- `{tool_status}` — status message for slow operations (e.g. booking)
- `{confirm_command}` — command awaiting user approval (run_command/run_python)
- `{content}` — final answer content
- `{usage}` — token usage stats
- `{error}` — error message
- `[DONE]` — stream complete

## UI Layout
Full-width top bar spanning entire window width with: colored session `+` buttons (left, 7 primary + 3 collapsible extra), Plugins button, status indicator grid (2 rows: core + APIs), menus (Prompts/Sessions/Templates), Context bar + Slots (right). Below: sidebar (conversation list) + main chat area side by side. Plugins config opens as a full-width panel overlaying the chat area. Input area has textarea with vertical button stack (Send/Stop/Save Prompt/Save Session), list mode button, and checkboxes (Applets/Autorun/Think/Retain/Precision/Taskmaster/Review).

### Conversation Pinning
Pin button (📌) in sidebar persists conversations to disk across server restarts. Compact button (≡) on pinned conversations sends the full conversation to the LLM for summarization — messages are irreversibly replaced with a structured summary preserving outcomes, decisions, and lessons learned. Two-click confirmation (click → "Compact?" → click again). Especially useful for long coding sessions with many tool rounds. Pinned conversations saved as individual JSON files in `data/pinned/<id>.json`. On startup, all pinned files loaded into the in-memory Map. Any mutation to a pinned conversation (new message, title change, token count) auto-saves to disk. `slotId` saved as `null` (slots are ephemeral). Sidebar sorts pinned conversations first, then by `updatedAt`. Unpinning removes the file but conversation stays in memory until restart.

### Obsidian Export
`plugin-obsidian.js` + `services/obsidian.js`, design in `docs/OBSIDIAN.md`. **Manual, one-way**: the
sidebar **Save to Obsidian** button writes the conversation as a Markdown note into an Obsidian vault.
Nothing syncs by itself (pinning, messages, compacts never touch the vault), nothing in the note links
back to the app, and the exporter never deletes from the vault (a title or colour change since the
last save **renames** the note, matched by the `-<id8>.md` suffix). Off by default.

- **Vault**: `OBSIDIAN_VAULT` → vault picked on the card → Obsidian registry (`~/.config/obsidian/obsidian.json`,
  Flatpak and Snap paths too; `open` vault first, then most recent). `resolveVault()` returns `null` when none
  exists and every path short-circuits: the hook no-ops (one warning per process), the route returns 409,
  the tool returns an error. Obsidian itself is never required — with `OBSIDIAN_VAULT` any folder works.
- **Trigger**: sidebar "Save to Obsidian" button (visible while the plugin is on) → `POST /:id/obsidian`
  with `{ color }`; or the `obsidian_export` tool when the user asks. The store has no hook and no
  Obsidian import.
- **Session colour and hidden prompts**: the export request carries `color` and the store keeps it as
  `conv.session` (it was browser-only state); session-init user messages are stored with `hidden: true`.
  The exporter uses them for the colour subfolder, the `lumispec/<colour>` tag and skipping the init prompt.
- **Note shape**: `<Folder>/<colour>/<slug>-<id8>.md`, YAML properties (title, id, created/updated,
  session, pinned, model, messages, tokens, tools_used, tags), `## 🧑/🤖 <local time>` per turn,
  reasoning and tool results as folded callouts (results trimmed to 1,500 chars; `_markdown` used when
  present; `_autoSaved` files linked), pipeline runs as `### Step n` / `#### Subtask n.m`, applets cut
  out into `<base>-applet-<n>.html` sidecars, user images and `/files/<name>` data files copied into the
  vault's attachment folder (`.obsidian/app.json` → `attachmentFolderPath`, default `<Folder>/attachments/`)
  with links rewritten to `[[name]]`. Writes are atomic (`.tmp` + rename) and path-guarded to the vault.
- `renderNote()` is pure and snapshot-tested in `test/obsidian.test.js` (`npm test`).
- Tool execution `context` now carries `conversationId` in both loops (documented before, never set).

## Key Architecture Details
- `.env` file is **required** — config.js exits if missing
- Project directory (`SOURCE_DIR`) served at `/files/` path (dynamic, follows `source_project` switches)
- llama-server sends `timings` (not OpenAI `usage`) — backend normalizes to `usage` format
- Tool results sent to LLM as `user` role messages: `Tool "name" result: {json}`
- Large tool results: auto-saved to file, only summary sent to LLM context (markdown tables truncated to 30 rows)
- Image data (`_images`), rate maps (`_rateMap`), and diff previews (`_diff`) stripped from LLM context but sent to frontend via SSE
- Vision: images sent as base64 `image_url` parts in OpenAI multipart format
- Template `[template: name]` expansion tells LLM to fetch fresh data first, update all dates/values, keep layout intact
- Conversations auto-titled from first visible user message text (truncated to 60 chars); hidden session init prompts skipped
- **Date/time is never in the system prompt.** `getDatetimeStamp(date)` (`src/tools/index.js`) renders a
  `[Now: ...]` line that is appended to every user message *as sent to the LLM*, never stored. Every
  stored message carries `sentAt` (set in `addMessage`), and the history rebuild re-derives each user
  message's stamp from it, so earlier turns are byte-identical across requests. The system prompt is
  therefore stable between turns and llama-server's KV cache prefix holds: measured 6,393 processed
  prompt tokens on a cold slot, then ~80 per turn with Retain on (only the new question). A clock in the
  system prompt used to force a full re-prefill on every turn. Messages without `sentAt` (older pinned
  conversations) are sent as stored. The pipeline stamps each step's user message at step time.
- Prompts/sessions titled by LLM via separate non-streaming completion (defensive prompt with triple-backtick wrapping, HTML stripping, error/refusal detection)
- Weather tool auto-adjusts `startDate` to tomorrow if today or earlier (LiteAPI requirement)
- Search engine switchable at runtime via POST `/api/health/search`
- Applet HTML in assistant messages stripped from LLM history context (replaced with `[Applet: TYPE visualization]`), kept in stored messages for frontend re-rendering
- `run_command` uses async `exec` (non-blocking event loop) instead of `execSync`
- Applet bubble width: `contentSpan` appended to bubble BEFORE `renderFormattedContent()` so parent traversal works for `max-w-[85%]` removal
- `HELP.md` — user-facing guide in plain language (no technical internals)

## Conventions
- ES modules (`import`/`export`) throughout
- No TypeScript, no bundler, no framework on frontend
- Tool results use `_markdown` key for rich display, `_autoSaved` for large results
- Reusable tabular helpers live in plugin-etrade.js — import and reuse in any plugin that needs CSV or Markdown table output:
  - `csvEscape(v)` — proper CSV value escaping (commas, quotes, newlines)
  - `toCsv(headers, rows)` — builds CSV string from headers array + 2D rows array
  - `toMd(title, headers, rows)` — builds GitHub-flavored Markdown table with title, pipe-escaping
  - Formatter map pattern (`formatters`/`mdFormatters` dicts) — clean dispatch for dual-format output
- E*TRADE data formatted with shared helpers (`formatExpiry`, `formatStrike`, `portfolioToCsv`, `transactionsToCsv`) — all in plugin-etrade.js
- Shared state stays in its plugin: `fileEditLocks` in plugin-source.js, `lastRateMap`/`lastPrebookId` in plugin-travel.js
