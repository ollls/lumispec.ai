# ScrapChat — Feature List

## Server & Configuration

- **Express.js v5** backend with ES modules throughout
- **50MB JSON upload limit** for large payloads
- Static file serving for frontend assets and `data/` directory at `/files/`
- **Mandatory `.env` file** — app exits on startup if missing
- **Dual LLM backend** — switch between llama.cpp and Claude API at runtime from the status bar, no restart needed
- **Search engine selection** — keiro, tavily, or both; switchable at runtime via status bar dropdown
- **Configurable Python venv** — path from `PYTHON_VENV` env var, falls back to system `python3`
- **E*TRADE sandbox mode** — toggle via `ETRADE_SANDBOX` env var for development/testing
- **Graceful shutdown** — SIGTERM handler with slot polling cleanup
- **Dev mode** — `npm run dev` uses Node.js `--watch` for auto-reload

## LLM Integration

- **llama.cpp backend** — OpenAI-compatible `/v1/chat/completions` endpoint with slot ID support
- **Claude API backend** — Anthropic `/v1/messages` endpoint with streaming and vision conversion
- **Streaming SSE** — real-time token streaming for both backends
- **Qwen3 reasoning support** — `reasoning_content` field extracted and streamed separately as collapsible "Thinking" blocks
- **Think block stripping** — `<think>...</think>` blocks auto-removed from context and final output
- **Vision support** — auto-detected from model capabilities; images sent as base64 in OpenAI multipart format
- **Claude vision conversion** — automatic format conversion from OpenAI image_url to Claude base64 source format
- **Consecutive role merging** — handles Claude API requirement for alternating user/assistant messages
- **System message extraction** — system prompt separated from message array for Claude compatibility
- **Non-streaming mode** — used for prompt title generation with thinking disabled
- **Timings normalization** — llama.cpp `timings` field normalized to OpenAI `usage` format

## Tool System

### Architecture
- **Prompt-based tool calling** — no OpenAI function-calling API required; LLM emits `<tool_call>` XML blocks with JSON arguments
- **Works with ANY local model** — Qwen, Llama, Mistral, DeepSeek, or anything running on llama.cpp
- **Tool registry** — tools registered as objects with `description`, `parameters`, and `execute` function
- **20-round tool loop** — backend loops up to 20 rounds executing tools and feeding results back
- **Max 4 parallel tools per round** — excess dropped to prevent context explosion
- **Per-signature repeat detection** — only truly identical calls (same name + same args) count toward the 3-repeat limit
- **Tool enable/disable at runtime** — toggle individual tools from the Tools dropdown without restarting
- **System prompt generation** — dynamically built from registered tools with conditional applet rules
- **Tool call logging** — every invocation logged to daily files (`logs/tools_YYYY-MM-DD.log`) with full args, raw results, and formatted results

### JSON Repair & Robustness
- **40+ JSON repair strategies** for broken LLM output
- **Unbalanced brace recovery** — string-aware brace counting with auto-closing
- **Python boolean fix** — `True`/`False`/`None` converted to JSON `true`/`false`/`null`
- **Missing quote repair** — detects and fixes missing opening/closing quotes
- **Equals-to-colon fix** — `key = value` converted to `key: value`
- **Smart newline escaping** — handles literal newlines in string arguments (common in code)
- **Manual content extraction** — extracts `code` argument from `run_python` without full JSON parsing when standard parsing fails
- **Bare JSON detection** — detects tool calls missing `<tool_call>` tags, prompts LLM to retry with proper format
- **Truncated tool call detection** — warns when `parseToolCalls` returns empty but content contains `{"name":`
- **Safety net execution** — scans final content for unparsed tool calls and executes them as a last resort

### Safety Mechanisms
- **Command confirmation** — `run_command` always requires user approval via SSE confirmation prompt
- **Python confirmation** — `run_python` requires approval unless autorun mode is enabled
- **120-second confirmation timeout** — auto-denies if user doesn't respond
- **Options-analysis safeguard** — detects when LLM fetches option expiry dates but forgets to fetch actual chains, forces continuation
- **Large result auto-save** — datasets with 30+ rows auto-saved to CSV; only summary + preview sent to LLM context
- **Markdown table truncation** — tables capped at 30 data rows in LLM context
- **Image/rate map stripping** — `_images` and `_rateMap` removed from LLM context but sent to frontend via SSE
- **Forced final answer** — after repeat limit or round exhaustion, LLM forced to answer with gathered data
- **One final chance** — after force message, LLM gets one more response; any remaining tool calls stripped

### Registered Tools

**current_datetime**
- Returns UTC and local time with IANA timezone and UTC offset
- No arguments required

**web_search**
- Dual search engine support: Keiro and Tavily
- Parallel search with URL-based deduplication when both engines enabled
- Source attribution per result (Keiro, Tavily, or both)
- 15-second timeout per engine
- Top 5 results per engine, 8 merged total

**web_fetch**
- Fetches web page and extracts content as clean markdown
- Mozilla Readability for article extraction
- Turndown for HTML-to-markdown conversion
- Fallback HTML boilerplate stripping (removes scripts, styles, navs, footers, headers)
- 4000-character truncation for token efficiency
- 10-second fetch timeout

**save_file**
- Saves content to `data/` directory with sanitized filename
- Returns `/files/` download URL
- Used for generated reports, code, CSV exports

**list_files**
- Enumerates files in data directory
- Returns filename, size, and last modified date
- Filters to regular files only

**file_read**
- Reads file contents from data directory
- Optional `head` parameter for first N lines
- CSV preview mode: header + 5 rows, prompts Python for full analysis
- 10KB truncation for large files

**run_command**
- Shell command execution from user's home directory
- Always requires user confirmation (no autorun bypass)
- 30-second timeout
- 1MB output buffer
- Captures stdout and stderr (8KB truncated each)

**run_python**
- Python script execution in configured venv
- Working directory set to `data/` for direct file access
- Auto-fixes JS-style booleans/null to Python (`true`→`True`, `false`→`False`, `null`→`None`)
- 120-second timeout with SIGKILL
- 2MB output buffer per stream
- File snapshot before/after execution to detect new/modified files
- Output files returned with download URLs and sizes
- Autorun toggle support — skips confirmation when enabled
- Temporary script file cleanup after execution

**etrade_account**
- Account actions: list, balance, portfolio, transactions, gains, orders, alerts, alert_detail, transaction_detail
- Market data actions: quote, optionchains, optionexpiry, lookup
- Account resolution by numeric ID, encoded key, or description ("IRA", "Brokerage")
- Auto-pagination for transactions (fetches all pages within date range)
- Default start date: January 1 of current year if not specified
- CSV export via `saveAs` parameter
- Markdown table preview with 15-row limit for large results
- Lightweight summary metadata per action (row counts, symbol lists)
- Portfolio with full options Greeks: Delta, Gamma, Theta, Vega, Rho, IV
- Option chains with bid/ask/volume/open interest
- Up to 25 symbols per quote request
- Chain type filtering: CALL, PUT, or CALLPUT
- Weekly options support via `includeWeekly` flag

**hotel** (LiteAPI)
- Actions: search, details, rates, reviews, semantic_search, ask
- Location-based and name-based hotel search
- Semantic/natural language hotel search
- Full hotel details with photos, amenities, policies, check-in/out times
- Real-time rate pricing with occupancy configuration (adults + children ages)
- Guest nationality and currency selection
- Rate deduplication by room type (cheapest kept)
- Rate caching for booking workflow (rate_N → offerId mapping)
- Image collection with deduplication (hotel + room photos)
- HTML tag stripping from descriptions
- Guest reviews with ratings, dates, pros/cons

**travel** (LiteAPI)
- Actions: weather, places, countries, cities, iata_codes, price_index
- Weather forecast by date range with auto-geocoding from city name
- Daily forecast breakdown: temperature, humidity, wind, rain, clouds
- Destination/area search with PlaceId returns
- Country and city listings
- IATA airport code lookup
- City-level hotel price index

**booking** (LiteAPI)
- Actions: prebook, book, list, details, cancel
- Prebook locks rate before booking
- Book completes reservation with guest details
- Rate reference resolution from last rates call
- Prebookid auto-caching for sequential operations
- Guest profile persistence (auto-save/load)
- Holder auto-fill from saved profile
- Guest list auto-generation from holder info
- Payment method defaulting
- Booking confirmation summary with reference numbers

## SSE Streaming Events

- `{reasoning}` — Qwen3 reasoning/thinking tokens streamed in real-time
- `{tool_content}` — streamed content during tool rounds so user sees progress
- `{tool_status}` — status messages for slow operations (e.g., booking confirmations)
- `{tool_use}` — completed tool call with name and result metadata
- `{confirm_command}` — command awaiting user approval (run_command/run_python)
- `{content}` — final answer content
- `{usage}` — token usage statistics
- `{error}` — error messages
- `[DONE]` — stream complete marker

### Streaming Behavior
- Tool content buffered with 30-character threshold before streaming
- Content suppression once JSON tool call start detected (prevents partial tool JSON from showing)
- Flushed tool content on stream completion
- Partial `<applet>` tags don't match extraction regex — render as text until complete

## Applet System

### Types
- `type="html"` — plain HTML/CSS/JS visualizations, dashboards, tables
- `type="chartjs"` — Chart.js v4 config-driven charts (pie, bar, line, radar, etc.)
- `type="svg"` — inline SVG diagrams and graphics

### Rendering
- Rendered as **sandboxed iframes** in chat bubbles (`sandbox="allow-scripts"` only — no DOM/cookie/localStorage access)
- Chart.js auto-injected from local bundle (`/lib/chart.min.js`) for `type="chartjs"`
- ResizeObserver auto-injected for dynamic iframe height adjustment via postMessage
- Height cap: 100-2000px range enforced
- Full-width bubble expansion when applets present
- Content validation: must contain `<script>`, `<svg>`, or `<canvas>`
- 50KB size cap with byte measurement
- Fallback: collapsible code block for invalid or oversized content

### Templates
- **Save as Template** — gold button below each rendered applet
- Template name input via browser prompt dialog
- Button state transitions: "Save as Template" → "Saving..." → "Saved"
- Templates stored in `data/templates.json` with id, name, type, html, createdAt
- Template listing returns metadata only (no HTML) for performance
- **Tag expansion** — `[template: name]` in user messages expanded server-side to full HTML with LLM instructions
- Case-insensitive template lookup by name
- Instructions prevent LLM from redesigning layout/styling — only updates data

### Context Management
- Applet HTML preserved in stored messages for frontend re-rendering
- Applet blocks replaced with `[Applet: TYPE visualization]` placeholders before sending to LLM
- Prevents applet HTML from consuming LLM context tokens

## Prompt System

### Storage & Operations
- JSON file persistence to `data/prompts.json`
- UUID generation per prompt
- CRUD operations: create, read, update, delete
- Drag-and-drop reorder with backend persistence via PUT `/api/prompts/reorder`

### Auto-Title Generation
- LLM generates 3-6 word titles via separate non-streaming completion
- 200-character input limit for title generation
- Qwen3 think block stripping from title output
- System prompt leak detection (rejects titles containing instruction text)
- Quote stripping from LLM output
- 60-character title cap
- Fallback: first 50 characters of prompt text if generation fails

### Built-in Macros
- `{$date}` — current date (YYYY-MM-DD)
- `{$time}` — current time (HH:MM AM/PM)
- `{$year}` — current year
- `{$month}` — current month name (e.g., "March")
- `{$day}` — current weekday name (e.g., "Friday")

### Variable Substitution
- User-defined variables: `{$VarName}` or `{$VarName:type}`
- Built-in macros excluded from variable extraction
- Duplicate variable names deduplicated (only first occurrence creates a field)
- **Variable types:**
  - `string` (default) — text input field
  - `date` — flatpickr single date calendar picker
  - `daterange` — flatpickr range mode calendar (click start and end dates)
  - `month` — flatpickr month/year picker, formatted as "March 2026"
- **Modal dialog** — fixed overlay with semi-transparent backdrop
  - Dynamic fields rendered per variable type
  - Cancel, Clear All, and Apply buttons
  - Enter key submits, Escape cancels
  - Auto-focus on first text input
  - Flatpickr instances properly destroyed on close

### Flatpickr Integration
- Bundled locally: `flatpickr.min.js`, `flatpickr.min.css`, `flatpickr-dark.css`
- Dark theme CSS overrides matching zinc/indigo UI palette
- Static inline rendering (calendar appears below input, not as floating dropdown)
- Range mode for daterange variables
- Instance lifecycle management (created on modal open, destroyed on close)

## Conversation Management

### In-Memory Store
- Map-based conversation storage (no persistence across restarts)
- UUID generation per conversation
- Metadata: id, title, messages, slotId, tokenCount, createdAt, updatedAt
- Sorted by updatedAt descending in listing

### Operations
- Create, list, get, delete conversations
- Update title
- Add message with role and content
- Update message content by index
- Set slot assignment
- Set token count

### Auto-Titling
- Triggered on first user message in new conversation
- Extracts text from structured content (handles image + text messages)
- Truncates to 60 characters

### Message Storage
- Structured content for vision messages: `{text, images}`
- Stored messages include reasoning and toolUses metadata
- Applet HTML preserved in storage for frontend re-rendering

## Slot Management (llama.cpp)

- **Bidirectional maps** — conversationId ↔ slotId mapping
- **Health polling** — llama-server health check every 5 seconds
- **Slot polling** — slot status fetched every 3 seconds
- **Cached slot data** — latest slot info cached for quick access
- **Slot assignment** — finds idle slot not mapped to any conversation
- **Slot release** — removes mapping when conversation deleted
- **Pin/Unpin** — explicit slot-to-conversation assignment via API
- **Slot lookup** — bidirectional lookup (conversation → slot and slot → conversation)
- **Enriched slot list** — GET `/api/slots` returns slots with conversation title/id mapping

### Slot Panel UI
- Collapsible panel below status bar
- Visual slot cards showing context cache usage with progress bar
- Conversation name display per slot
- Pin/Unpin buttons for manual slot assignment
- Slot ID and token count display

## E*TRADE Integration

### OAuth 1.0a Flow
- Browser-based authentication with verifier code
- Sandbox vs production environment toggle
- In-memory token storage only (tokens cleared on restart, never written to disk)
- Status check, auth start, auth complete, disconnect endpoints

### Account Features
- **Account resolution** — flexible input: numeric ID, encoded key, or description ("IRA", "Rollover IRA", "Brokerage")
- **Cached account list** for quick resolution without extra API call
- **Auto-pagination** for transactions — fetches ALL matching records within date range
- **Default date range** — January 1 of current year if no startDate specified
- **Portfolio with options Greeks** — Delta, Gamma, Theta, Vega, Rho, IV for option positions
- **Lot-level cost basis** — unrealized gains with short/long-term classification
- **Order history** — filterable by status (OPEN/EXECUTED/CANCELLED), date range, count
- **Account/stock alerts** — filterable by category and read/unread status
- **Real-time quotes** — up to 25 symbols with fundamental/intraday/options detail flags
- **Option chains** — full Greeks, bid/ask, volume, open interest; filterable by chain type, expiry, strike range
- **Option expiry dates** — all available expirations for a symbol
- **Symbol lookup** — search by company name or partial symbol

### Data Export
- CSV export via `saveAs` parameter on any action
- Markdown table generation with proper formatting
- CSV column formatters for portfolio, transactions, options
- Large result auto-save (30+ rows) with summary metadata to LLM

## LiteAPI Travel Integration

### Hotel Search & Details
- Location-based, name-based, and semantic/natural language search
- Full hotel details: photos, amenities, policies, check-in/out times, pet/child allowance
- Real-time rate pricing with multi-occupancy support
- Rate deduplication by room type (cheapest retained)
- Guest reviews with ratings, dates, headline, pros/cons
- Image collection with deduplication

### Booking Workflow
- **Prebook** — locks rate for booking
- **Book** — completes reservation with guest/holder details
- **Guest profile persistence** — auto-saves firstName, lastName, email, phone on successful booking
- **Holder auto-fill** — pre-populates from saved profile
- **Guest auto-generation** — creates guest list from holder info
- **Rate reference resolution** — maps rate_N labels to actual offerIds from cached rates
- **Prebookid caching** — carried forward for sequential prebook → book flow
- **List/Details/Cancel** — full booking lifecycle management

### Travel Reference Data
- Weather forecast by date range with auto-geocoding from city name
- Daily breakdown: temperature, humidity, wind speed, rain probability, cloud cover
- Destination search with PlaceId returns
- Country and city listings by country code
- IATA airport codes
- Hotel price index by city

## Frontend UI

### Status Bar
- **LLM indicator** — colored dot + label with dropdown to switch backends at runtime
- **Internet indicator** — connectivity check against Cloudflare 1.1.1.1
- **Search indicator** — current engine label with dropdown to switch (keiro/tavily/both)
- **LiteAPI indicator** — key validation status (hidden if not configured)
- **E*TRADE indicator** — auth status with expandable panel for OAuth flow
- **Slot toggle** — shows slot count, expands slot panel
- **Tool usage counter** — shows count of tool calls in current conversation with expandable history dropdown
- **Tools button** — dropdown with enable/disable toggles per tool
- **Prompts button** — dropdown with saved prompts, click to insert (with variable modal if needed)
- **Templates button** — dropdown with saved applet templates, click to insert `[template: name]` tag
- **Context bar** — live progress bar showing token consumption vs max context with numeric label

### Chat Messages
- Role-based styling: user (indigo), assistant (zinc), error (red)
- User image grid with thumbnails
- Image overlay modal on click (full-viewport with semi-transparent backdrop, close by clicking outside)
- Reasoning blocks: collapsible "Thinking" section (collapsed by default, max-height 60px)
- Tool use indicators with name and result metadata
- Tool use photo gallery: collapsible thumbnail section
- File download links with size display
- Markdown rendering via marked.js with syntax highlighting (highlight.js, github-dark theme)
- DOMPurify sanitization on all rendered HTML
- Mermaid v11 diagram rendering: flowcharts, pie charts, xychart-beta (bar/line), timelines, mindmaps, Gantt charts, sequence diagrams, journey maps
- Pie chart auto-conversion to xychart-beta bar chart when values contain negatives

### Input Form
- Textarea with auto-grow (expands to fit content, max 200px)
- **Attach image button** — opens file picker for multiple images
- **Applets toggle** — checkbox to enable/disable applet generation (persisted to localStorage)
- **Autorun toggle** — checkbox to skip Python confirmation (persisted to localStorage)
- **Clear button** — clears input textarea
- **Send button** — disabled during streaming, re-enabled on completion
- **Save button** — saves current input as prompt to library with auto-generated title

### Image Handling
- Drag-and-drop upload anywhere on the form with visual drag-over highlighting
- Button upload with multi-file selection
- Clipboard paste support
- Preview strip with thumbnails and per-image remove buttons
- Base64 encoding with MIME type tracking
- Lazy loading for tool result thumbnails

### Command Confirmation UI
- Command preview rendered in code block
- Approve / Deny buttons
- Enter key shortcut for quick approval
- Button state updates after user response

### Conversation Sidebar
- Scrollable list with conversation titles
- Hover-to-show delete button
- Delete confirmation with 3-second timeout
- Conversation switching with in-flight stream abort
- "New Chat" button creates empty conversation

### Keyboard Shortcuts
- Enter to send message
- Shift+Enter for newline in textarea
- Enter to approve pending command
- Escape to close prompt variables modal
- Enter to submit prompt variables modal

## Mermaid Diagrams

- Full Mermaid v11 syntax support
- Dark theme auto-initialization
- Supported types: pie, xychart-beta, flowchart, timeline, mindmap, gantt, journey, sequenceDiagram
- Auto-conversion: pie charts with negative values converted to xychart-beta bar charts
- Rendered inline in chat messages

## Security

- **Iframe sandboxing** — `sandbox="allow-scripts"` without `allow-same-origin` for applets
- **DOMPurify** — all rendered HTML sanitized before display
- **Filename sanitization** — base name extraction, special character removal
- **CSV escaping** — proper escape handling for special characters in exports
- **OAuth tokens in-memory only** — never persisted to disk, cleared on restart
- **Command confirmation** — shell commands require explicit user approval
- **Applet size cap** — 50KB limit prevents oversized iframe content
- **File read truncation** — 10KB cap prevents excessive context consumption
- **Web fetch truncation** — 4000 characters max
- **Tool output truncation** — 8KB cap on stdout/stderr
- **Python timeout** — 120-second SIGKILL prevents runaway scripts
- **Shell timeout** — 30-second timeout on command execution

## Logging & Debugging

- **Daily tool call logs** — `logs/tools_YYYY-MM-DD.log` with timestamped entries
- **Log format** — separator bars, args, raw result, formatted result (sent to LLM)
- **Image/rate stripping in logs** — replaced with count placeholders to reduce log size
- **Console logging** — tool loop progress, round numbers, timing, repeat detection, warnings
- **Parse failure diagnostics** — first 500 and last 200 characters of content logged on tool call parse failures
- **Python execution logging** — file snapshot counts, spawn timing, exit codes, output sizes
- **Slot polling logging** — health check and slot fetch status

## Dependencies

- `express` — web framework (v5)
- `dotenv` — environment variable loading
- `@mozilla/readability` — web article content extraction
- `linkedom` — DOM implementation for server-side Readability
- `turndown` — HTML-to-markdown conversion
- `oauth` — E*TRADE OAuth 1.0a implementation

### Frontend (CDN + Local)
- `marked.js` — markdown parsing (CDN)
- `DOMPurify` — HTML sanitization (CDN)
- `highlight.js` — syntax highlighting with github-dark theme (CDN)
- `Mermaid v11` — diagram rendering (CDN)
- `Chart.js v4` — charting library (local bundle at `/lib/chart.min.js`)
- `flatpickr` — calendar date pickers (local bundle at `/lib/flatpickr.min.js`)
- `Tailwind CSS v4` — utility-first CSS framework (CLI build)
