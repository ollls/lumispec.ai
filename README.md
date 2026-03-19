# ScrapChat

Self-hosted AI-powered financial analysis workbench built on [llama.cpp](https://github.com/ggerganov/llama.cpp). Connects to your E\*TRADE brokerage account and uses a local LLM to analyze portfolios, option chains, transactions, and market data — with Python executing all financial calculations, not the LLM.

The LLM orchestrates: it reads your account data, writes Python scripts for quantitative analysis, and renders results as interactive visualizations — all running on your own hardware with no cloud AI services.

## Why Python for Financial Math

LLMs are unreliable at arithmetic. ScrapChat solves this by separating concerns:

- **LLM decides what to compute** — identifies the analysis needed, selects the right data
- **Python does the math** — pandas, numpy, scipy handle calculations with full numerical precision
- **LLM presents results** — generates charts, tables, and narrative summaries from Python output

When you ask "what's my portfolio beta?", the LLM fetches your holdings via E\*TRADE, writes a Python script to calculate beta against SPY using actual return data, executes it, and visualizes the result — no mental math, no hallucinated numbers.

## Key Features

### E\*TRADE Integration
Full read access to your brokerage account through OAuth 1.0a:

- **Portfolio** — Holdings with market values, cost basis, daily P&L, and allocation breakdown
- **Option chains** — Full Greeks (Delta, Gamma, Theta, Vega, Rho, IV) for any underlying
- **Transactions** — Complete trade history with auto-pagination (fetches hundreds of records)
- **Unrealized gains** — Lot-level cost basis with short/long-term classification
- **Real-time quotes** — Up to 25 symbols with fundamental and intraday data
- **Orders & alerts** — Open order status, account alerts
- **Symbol lookup** — Search by company name or partial ticker

Account resolution is flexible — use numeric IDs, encoded keys, or human-readable descriptions like "IRA" or "Brokerage".

### Python Execution
Sandboxed Python environment for financial computation:

- Runs in a dedicated virtual environment with pandas, numpy, matplotlib, and any packages you install
- Scripts execute in the data directory for easy file I/O
- **Autorun mode** — toggle in UI to skip confirmation prompts for faster iteration
- Auto-detects generated files (CSV, PNG, HTML) and returns download URLs
- 120-second timeout, 2MB output buffer

### Interactive Visualizations (Applets)
The LLM generates interactive HTML visualizations rendered in sandboxed iframes directly in chat:

- **Chart.js** — Bar, line, pie, radar, scatter, area charts (config-driven, no code needed)
- **SVG** — Flowcharts, diagrams, architecture maps
- **HTML/CSS/JS** — Sortable tables, calculators, interactive dashboards

Chart.js is bundled locally — no CDN dependency. Applets are sandboxed (`allow-scripts` only) with no access to the parent page.

### Web Research
- **Dual search engines** — Keiro and Tavily with runtime switching
- **Web fetch** — Extract page content as clean markdown (Readability + Turndown)

### File Management
- Save generated reports, CSVs, and charts to the data directory
- Read and preview files (CSV shows first 5 rows + row count)
- All files served at `/files/` for download

### Shell Commands
Execute shell commands with explicit user confirmation (never auto-approved, unlike Python).

## Example Workflows

**Portfolio analysis** — "Show my portfolio allocation as a pie chart"
→ LLM fetches holdings → generates Chart.js pie chart applet with sector/position breakdown

**Options screening** — "Find AMD calls expiring next Friday with delta > 0.3"
→ LLM fetches expiration dates → pulls option chain → filters by Greeks → renders HTML table

**Tax-loss harvesting** — "Which positions should I sell for tax-loss harvesting?"
→ LLM fetches unrealized gains → Python script identifies short-term losses → generates ranked CSV report

**Performance tracking** — "Calculate my win rate and average return on closed trades this quarter"
→ LLM fetches transaction history → Python computes statistics → applet shows summary with charts

**Covered call analysis** — "Find the best covered call for my AAPL shares targeting 2% monthly premium"
→ LLM checks position size → fetches option chain → Python calculates annualized return by strike → renders comparison table

## Prerequisites

- **Node.js** >= 20
- **llama.cpp server** running with an OpenAI-compatible endpoint
- **Python virtual environment** with pandas/numpy/matplotlib (for financial calculations)
- **E\*TRADE developer account** (for brokerage access — [developer.etrade.com](https://developer.etrade.com))

## Quick Start

```bash
git clone https://github.com/ollls/ScrapChat.git
cd ScrapChat
npm install

cp .env.example .env
# Edit .env — see Configuration below

npm run build    # Build Tailwind CSS
npm start        # Start the server
```

Open [http://localhost:3000](http://localhost:3000).

## Configuration

All settings via `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `LLAMA_URL` | `http://localhost:8080` | llama.cpp server URL |
| `LLAMA_MAX_CONTEXT` | `131072` | Fallback max context tokens (auto-detected from server) |
| `ETRADE_CONSUMER_KEY` | — | E\*TRADE OAuth consumer key |
| `ETRADE_CONSUMER_SECRET` | — | E\*TRADE OAuth consumer secret |
| `ETRADE_SANDBOX` | `true` | Use E\*TRADE sandbox environment |
| `PYTHON_VENV` | — | Path to Python virtual environment (e.g. `~/uv_python_env`) |
| `SEARCH_ENGINE` | `keiro` | Search engine: `keiro`, `tavily`, or `both` |
| `KEIRO_API_KEY` | — | Keiro search API key |
| `KEIRO_BASE_URL` | `https://kierolabs.space/api` | Keiro API base URL |
| `TAVILY_API_KEY` | — | Tavily search API key |
| `LITEAPI_KEY` | — | LiteAPI hotel/travel API key (optional) |

### llama.cpp Server

```bash
# Text-only model
llama-server -m your-model.gguf -c 131072 --port 8080

# Vision-enabled model (e.g., Qwen3.5)
llama-server -m qwen3.5-vision.gguf -c 131072 --port 8080
```

Vision support is auto-detected — image uploads enable automatically when the model supports it.

### E\*TRADE Setup

1. Register at [developer.etrade.com](https://developer.etrade.com) to get consumer key and secret
2. Add credentials to `.env`
3. Start the app and click the E\*TRADE indicator in the status bar
4. Complete the OAuth flow (browser redirect → paste verification code)

OAuth tokens are held in memory and expire on restart — no credentials are persisted to disk.

### Python Environment

```bash
# Create a venv with financial packages
python -m venv ~/finance_venv
source ~/finance_venv/bin/activate
pip install pandas numpy matplotlib scipy plotly
```

Set `PYTHON_VENV=~/finance_venv` in `.env`.

## UI Overview

- **Sidebar** — Conversation list, create/switch/delete chats
- **Status bar** — Health indicators for llama.cpp, internet, search engines, E\*TRADE, and LiteAPI; search engine switcher; context usage bar
- **Chat** — Markdown rendering, syntax highlighting, collapsible reasoning blocks (Qwen3 `<think>`), tool-use indicators, inline applet visualizations
- **Input** — Image attachments (button, paste, drag-and-drop), Applets toggle, Autorun toggle
- **Slot panel** — Monitor llama.cpp server slots, pin/unpin conversations

## Tool System

Prompt-based tool calling with automatic multi-round execution (up to 20 rounds, max 4 parallel calls per round). The LLM emits `<tool_call>` blocks; the backend executes and feeds results back until a final answer is produced. Tools can be toggled on/off at runtime.

### Registered Tools

| Tool | Description |
|---|---|
| `current_datetime` | Current UTC/local time, timezone, offset |
| `web_search` | Web search via Keiro and/or Tavily |
| `web_fetch` | Fetch URL → clean markdown |
| `save_file` | Save content to data directory |
| `list_files` | List files with size and date |
| `file_read` | Read file contents (CSV preview mode) |
| `run_command` | Shell execution (requires confirmation) |
| `run_python` | Python script in venv (confirmation or autorun) |
| `etrade_account` | E\*TRADE: portfolio, quotes, options, transactions, orders, gains, alerts |
| `hotel` | LiteAPI: hotel search, rates, reviews, semantic search |
| `travel` | LiteAPI: weather, places, countries, cities, IATA codes |
| `booking` | LiteAPI: prebook, book, manage reservations |

### Safety Mechanisms

- **Repeat detection** — Max 3 identical tool calls, then auto-disabled
- **Parallel limit** — Max 4 concurrent tool calls per round
- **Command confirmation** — `run_command` always requires approval; `run_python` respects autorun toggle
- **Large results** — Auto-saved to file, only summary sent to LLM context
- **Applet sandboxing** — `sandbox="allow-scripts"` without `allow-same-origin`
- **Applet size cap** — 50KB per visualization

### Adding a New Tool

Add an entry to the `tools` object in `src/services/tools.js`:

```js
my_tool: {
  description: 'What it does and what arguments it needs.',
  parameters: { arg1: 'string', arg2: 'number' },
  execute: async ({ arg1, arg2 }) => {
    return { result: 'value' };
  },
},
```

The tool is automatically registered in the system prompt, executable by the tool loop, and visible in the UI.

## Development

```bash
npm run dev          # Dev server with auto-reload
npm run css:watch    # Watch & rebuild Tailwind CSS (separate terminal)
```

## Tech Stack

- **Runtime**: Node.js (ES modules)
- **Framework**: Express v5
- **CSS**: Tailwind CSS v4
- **Frontend**: Vanilla JS — no bundler, no framework
- **LLM**: llama.cpp (OpenAI-compatible API)
- **Auth**: OAuth 1.0a (E\*TRADE)
- **Extraction**: Mozilla Readability + Turndown

## Architecture

```
src/
  config.js                # .env configuration loader
  server.js                # Express entry point
  routes/
    conversations.js       # Chat CRUD + SSE streaming + command confirmation
    slots.js               # Slot management endpoints
    health.js              # Health checks (llama, internet, search, APIs)
    etrade.js              # E*TRADE OAuth flow
    prompts.js             # Prompt library CRUD
    tools.js               # Tool toggle endpoints
  services/
    conversations.js       # In-memory conversation store
    llm.js                 # llama-server client (streaming + SSE parser)
    tools.js               # Tool registry, system prompt, execution engine
    slots.js               # Slot polling and assignment
    prompts.js             # Prompt persistence
    etrade.js              # E*TRADE OAuth + API wrapper
    liteapi.js             # LiteAPI client
  views/index.html         # Main UI
  public/
    js/app.js              # Client-side application
    lib/chart.min.js       # Bundled Chart.js v4
data/                      # Runtime: saved files, prompts (served at /files/)
logs/                      # Tool call logs (tools_YYYY-MM-DD.log)
```

In-memory store — conversations, OAuth tokens, and tool state reset on restart.

## License

ISC
