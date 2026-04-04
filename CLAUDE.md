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
Running Qwen3.5-35B-A3B (MoE, 3B active params) on RTX 5090:

```bash
export CUDA_VISIBLE_DEVICES=0  # Ensure RTX 5090 is used

./llama.cpp/build/bin/llama-server \
  -hf unsloth/Qwen3.5-35B-A3B-GGUF:UD-Q4_K_XL \
  --jinja \
  -ngl 99 \
  --ctx-size 65536 \
  -fa auto \
  --temp 0.7 \
  --top-p 0.95 \
  --min-p 0.01 \
  --top-k 40
```

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
    llm.js                 # llama-server client (streaming, non-streaming, SSE parser)
    tools.js               # Backward-compat barrel (re-exports from ../tools/index.js)
    slots.js               # Slot monitor (polling, assignment, pin/unpin)
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
data/                      # Runtime data dir: saved files, prompts.json, sessions.json, tasks.json (served at /files/)
  plugins.json             # Plugin enable/disable config (auto-created on first toggle, gitignored)
  pinned/                  # Pinned conversation JSON files (<id>.json)
logs/                      # Tool call logs (tools_YYYY-MM-DD.log)
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
| `/api/tools` | GET | List tools with enabled status |
| `/api/tools/:name/toggle` | POST | Enable/disable a tool |
| `/api/tasks` | GET/POST | List/create tasks (saved task lists) |
| `/api/tasks/:id` | PATCH/DELETE | Update/delete task |
| `/api/tasks/reorder` | PUT | Reorder tasks |

## Commands
- `npm run dev` — start dev server with --watch
- `npm start` — start production server
- `npm run css:build` — build Tailwind CSS
- `npm run css:watch` — watch & rebuild Tailwind CSS

## Environment Variables (via .env, required)
- `PORT` — server port (default: 3000)
- `LLAMA_URL` — llama-server base URL (default: `http://localhost:8080`)
- `LLAMA_MAX_CONTEXT` — fallback max context tokens (default: 65536, overridden by slot `n_ctx`)
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

## Tool System
Prompt-based tool calling: system prompt defines `<tool_call>` protocol. Backend loops up to 20 rounds executing tools and feeding results back until LLM produces a final answer. Tool-call rounds stream content as `{tool_content}` SSE events for user feedback. Final answer sent as `{content}` SSE event.

### Plugin Architecture
Tools are organized as per-group plugins in `src/tools/plugin-*.js`. Each plugin is a self-contained ES module auto-discovered by `loadPlugins()` at startup. The core index (`src/tools/index.js`) handles registration, system prompt assembly, parsing, execution, logging, and confirmation. `src/services/tools.js` is a backward-compat barrel that re-exports everything from `../tools/index.js`.

**Plugin Configuration**: Configurable plugins (source, travel, finance) can be hot-loaded/unloaded at runtime via the Plugins panel in the UI. Config persisted to `data/plugins.json` (gitignored, auto-created). Always-on plugins (`core`, `web`, `execution`) are not shown in the config UI. Each plugin exports optional `label` and `description` fields for the UI. `GET /api/plugins` lists configurable groups with tool names/descriptions. `POST /api/plugins/:group/toggle` hot-loads/unloads a plugin and persists the change.

#### Plugin Interface
Each `plugin-*.js` exports a default object:

```javascript
export default {
  group: 'mygroup',                              // group name (unique, used in toolGroups registry)
  label: 'My Plugin',                            // human-readable name for Plugins config UI (optional)
  description: 'What this plugin does.',         // short description for Plugins config UI (optional)
  condition: () => someCheck(),                   // optional: group only active when true (omit for always-on)
  routing: ['- Question type → use "my_tool"'],   // LLM routing hints (array of strings, optional)
  prompt: '## My Section\n- Rule 1\n- Rule 2',   // system prompt section injected when group active (optional)
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

| Group | Plugin | Tools | Condition |
|---|---|---|---|
| `core` | plugin-core.js | `current_datetime` | — |
| `web` | plugin-web.js | `web_search`, `web_fetch` | — |
| `execution` | plugin-execution.js | `run_python` | — |
| `source` | plugin-source.js | 8 source tools + `template_save` | `config.sourceDir` set |
| `travel` | plugin-travel.js | `hotel`, `travel`, `booking` | — |
| `finance` | plugin-etrade.js | `etrade_account` | `etrade.isAuthenticated()` |

`isToolGroupEnabled(name)` exported for runtime checks in `conversations.js`.

Safety mechanisms:
- Max 3 identical tool call repeats (same name+args signature), then tool is disabled
- Max 4 parallel tool calls per round (excess dropped)
- Bare/malformed JSON tool calls trigger retry prompts (skipped when response contains `<applet>` blocks)
- Safety net catches unparsed tool calls in final content (also skipped for applet responses)
- Options-analysis continuation: forces optionchains call if LLM stops after fetching expiry data (finance group only)
- Fabrication detector: catches LLM presenting Greeks/prices without fetching data (finance group only)
- Tool call logging to `logs/` directory
- Queue-based command confirmation: parallel calls confirmed FIFO (not single-slot)
- Truncated tool call repair: extracts partial code/command from incomplete JSON instead of failing
- run_python auto-fixes: Python booleans (`fixPythonBooleans`), backslash+newline double-escaping in string literals

### Registered Tools
| Tool | Description |
|---|---|
| `current_datetime` | Returns UTC, local time, IANA timezone, UTC offset |
| `web_search` | Web search via Keiro and/or Tavily (configurable) |
| `web_fetch` | Fetch URL, extract content as markdown (Readability + Turndown) |
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

**Execution engine:** Each task/subtask runs through the same tool loop as regular chat (up to 20 tool rounds, repeat detection, parallel tool cap, confirmation flow, full SSE streaming).

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
- Global `message` listener for iframe resize (100-20000px height cap, scroll fallback when exceeded)
- Resize measurement: temporarily sets `overflow:visible` on body to get true `scrollHeight`, then restores
- Streaming safety: partial `<applet>` tags don't match regex (needs both open+close), render as text until final render

**Context management** (conversations.js): Assistant messages in history have `<applet>...</applet>` blocks replaced with `[Applet: TYPE visualization]` before sending to LLM, preserving stored content for frontend re-rendering.

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
Full-width top bar spanning entire window width with: colored session `+` buttons (left, 7 primary + 3 collapsible extra), Plugins button, status indicator grid (2 rows: core + APIs), menus (Prompts/Sessions/Templates), Context bar + Slots (right). Below: sidebar (conversation list) + main chat area side by side. Plugins config opens as a full-width panel overlaying the chat area. Input area has textarea with vertical button stack (Send/Stop/Save Prompt/Save Session), list mode button, and checkboxes (Applets/Autorun/Think/Precision/Taskmaster/Review).

### Conversation Pinning
Pin button (📌) in sidebar persists conversations to disk across server restarts. Compact button (≡) on pinned conversations sends the full conversation to the LLM for summarization — messages are irreversibly replaced with a structured summary preserving outcomes, decisions, and lessons learned. Two-click confirmation (click → "Compact?" → click again). Especially useful for long coding sessions with many tool rounds. Pinned conversations saved as individual JSON files in `data/pinned/<id>.json`. On startup, all pinned files loaded into the in-memory Map. Any mutation to a pinned conversation (new message, title change, token count) auto-saves to disk. `slotId` saved as `null` (slots are ephemeral). Sidebar sorts pinned conversations first, then by `updatedAt`. Unpinning removes the file but conversation stays in memory until restart.

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
- Prompts/sessions titled by LLM via separate non-streaming completion (defensive prompt with triple-backtick wrapping, HTML stripping, error/refusal detection)
- Weather tool auto-adjusts `startDate` to tomorrow if today or earlier (LiteAPI requirement)
- Search engine switchable at runtime via POST `/api/health/search`
- Applet HTML in assistant messages stripped from LLM history context (replaced with `[Applet: TYPE visualization]`), kept in stored messages for frontend re-rendering
- `run_command` uses async `exec` (non-blocking event loop) instead of `execSync`
- Applet bubble width: `contentSpan` appended to bubble BEFORE `renderFormattedContent()` so parent traversal works for `max-w-[80%]` removal
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
