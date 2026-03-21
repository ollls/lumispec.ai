# ScrapChat

![ScrapChat](Screenshot_2026-03-21_17-11-43.png)

A self-hosted AI assistant that runs on your own hardware. Connect any local LLM via [llama.cpp](https://github.com/ggerganov/llama.cpp) and get a full-featured chat interface with web search, code execution, interactive visualizations, travel planning, and deep E\*TRADE brokerage integration — all private, no cloud AI required.

## Install

```bash
git clone https://github.com/ollls/ScrapChat.git
cd ScrapChat
npm install
cp .env.example .env   # Edit with your settings
npm run css:build      # Build Tailwind CSS
npm start              # Open http://localhost:3000
```

Requires: **Node.js >= 20** and a running **llama.cpp server** (`llama-server -m model.gguf -c 131072 --port 8080`).

## What It Does

ScrapChat is a universal assistant. Ask it anything — it picks the right tools automatically:

- **Search the web** and summarize articles
- **Check weather** and plan trips with hotel search and booking
- **Write and run Python** scripts for data analysis, charts, and reports
- **Execute shell commands** on your machine
- **Generate interactive dashboards** — Chart.js, SVG, and HTML visualizations right in chat
- **Manage your E\*TRADE portfolio** — holdings, options, transactions, real-time quotes
- **Read its own source code** — it knows how it works and can help you modify it

### Financial Analysis

The LLM doesn't do math — Python does. When you ask "what's my portfolio beta?", the LLM fetches your holdings via E\*TRADE, writes a Python script with pandas/numpy, runs it, and renders the result as an interactive chart. Full precision, no hallucinated numbers.

- Portfolio allocation, P&L, unrealized gains
- Option chains with full Greeks (Delta, Gamma, Theta, Vega, IV)
- Transaction history with auto-pagination
- Covered call screening, tax-loss harvesting, performance tracking

## Sessions, Prompts & Templates

### Sessions
Five colored buttons in the top bar — each represents a session type. Click one to start a new chat. Save a session prompt per color and it auto-submits on creation. Hover any button to see its saved prompt title.

Examples: a daily briefing session, a coding assistant session, a financial analysis session, a support/help session.

### Prompts
A library of reusable text snippets. Click to load into the input box. Supports variables that prompt you for input:

- `{$date}`, `{$time}`, `{$location}` — auto-filled
- `{$City}`, `{$Symbol}` — text input dialog
- `{$CheckIn:date}`, `{$Stay:daterange}` — calendar pickers

Save any input text as a prompt with one click — title is auto-generated.

### Templates
Save any visualization the AI creates and reuse it. Type `[template: Weather]` and the AI regenerates the same dashboard layout with fresh data. Great for recurring reports and dashboards.

All three menus support **drag-to-reorder** and **inline title editing**.

## Configuration

All settings via `.env`:

| Variable | Description |
|---|---|
| `PORT` | Web server port (default: 3000) |
| `LLAMA_URL` | llama.cpp server URL (default: http://localhost:8080) |
| `LOCATION` | Your default location for weather/travel (e.g. "Oakland Park, FL") |
| `SOURCE_DIR` | Project root path — enables AI self-awareness |
| `PYTHON_VENV` | Path to Python venv for code execution |
| `SEARCH_ENGINE` | `keiro`, `tavily`, or `both` |
| `TAVILY_API_KEY` | Tavily search key |
| `KEIRO_API_KEY` | Keiro search key |
| `LITEAPI_KEY` | LiteAPI key for hotels/travel (optional) |
| `ETRADE_CONSUMER_KEY` | E\*TRADE OAuth key (optional) |
| `ETRADE_CONSUMER_SECRET` | E\*TRADE OAuth secret |
| `ETRADE_SANDBOX` | `true` for sandbox mode |

### Optional: E\*TRADE

1. Register at [developer.etrade.com](https://developer.etrade.com)
2. Add credentials to `.env`
3. Click the E\*TRADE indicator in the app and complete OAuth

Tokens are in-memory only — nothing persisted to disk.

### Optional: Python

```bash
python -m venv ~/finance_venv
source ~/finance_venv/bin/activate
pip install pandas numpy matplotlib scipy plotly
```

Set `PYTHON_VENV=~/finance_venv` in `.env`.

## UI at a Glance

- **Top bar** — Session buttons, service status indicators, LLM/search engine switcher, context usage, elapsed timer
- **Sidebar** — Conversation list with switching and delete
- **Chat** — Markdown, syntax highlighting, Mermaid diagrams, collapsible reasoning, interactive applets
- **Input** — Image attachments (paste, drag, button), checkboxes for Applets/Autorun/Think
- **Menus** — Tools (toggle on/off), Prompts, Sessions, Templates

## Tools

The AI has 13 built-in tools it uses automatically:

| Tool | What it does |
|---|---|
| `web_search` | Search the web |
| `web_fetch` | Read a webpage |
| `run_python` | Execute Python scripts |
| `run_command` | Run shell commands |
| `save_file` / `list_files` / `file_read` | File management |
| `source_read` | Read this app's own source code |
| `etrade_account` | E\*TRADE portfolio, quotes, options, orders |
| `hotel` / `travel` / `booking` | Hotel search, weather, trip booking |
| `current_datetime` | Current time and timezone |

Tools can be toggled on/off at runtime from the Tools menu. Add your own in `src/services/tools.js`.

## Development

```bash
npm run dev          # Auto-reload server
npm run css:watch    # Watch Tailwind CSS (separate terminal)
```

## Tech Stack

Node.js, Express v5, Tailwind CSS v4, vanilla JS frontend. No bundler, no framework, no build step beyond CSS.

## License

ISC
