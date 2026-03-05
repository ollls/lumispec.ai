# ScrapChat

A lightweight, self-hosted chat interface for [llama.cpp](https://github.com/ggerganov/llama.cpp) server. Multi-conversation UI with web search, vision support, and real-time slot monitoring — no cloud APIs required for core functionality.

## Features

- **Multi-conversation** — Create, switch, and delete conversations from the sidebar
- **SSE streaming** — Real-time token streaming with support for reasoning models (Qwen3 `<think>` blocks shown in collapsible sections)
- **Vision / image support** — Attach images via button, clipboard paste, or drag-and-drop; works with multimodal models like Qwen3.5
- **Web search** — Built-in Tavily search tool the LLM can invoke autonomously to answer questions with up-to-date information
- **Web fetch** — LLM can read web pages, extracting content as clean markdown via Readability
- **Tool calling** — Prompt-based tool protocol with automatic multi-round execution (up to 5 rounds)
- **Slot management** — Monitor llama.cpp server slots, pin/unpin conversations to specific slots
- **Context tracking** — Live context usage bar reading actual `n_ctx` from the server
- **Status bar** — At-a-glance health indicators for llama.cpp, internet connectivity, and Tavily search
- **Dark theme** — Clean, minimal UI built with Tailwind CSS v4

## Prerequisites

- **Node.js** >= 20
- **llama.cpp server** running with an OpenAI-compatible endpoint (`/v1/chat/completions`)
- **Tavily API key** (optional, for web search — [get one free at tavily.com](https://tavily.com))

## Quick Start

```bash
# Clone the repository
git clone https://github.com/ollls/ScrapChat.git
cd ScrapChat

# Install dependencies
npm install

# Build CSS
npm run build

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

All configuration is via environment variables. Set them inline or in a `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `LLAMA_URL` | `http://localhost:8080` | llama.cpp server URL |
| `LLAMA_MAX_CONTEXT` | `131072` | Fallback max context tokens (auto-detected from server slots) |
| `TAVILY_API_KEY` | — | Tavily search API key (optional, enables web search tool) |

**Example:**

```bash
LLAMA_URL=http://192.168.1.100:8080 TAVILY_API_KEY=tvly-your-key npm start
```

## llama.cpp Server Setup

ScrapChat connects to a running [llama-server](https://github.com/ggerganov/llama.cpp/tree/master/examples/server). Start it with any GGUF model:

```bash
# Text-only model
llama-server -m your-model.gguf -c 131072 --port 8080

# Vision-enabled model (e.g., Qwen3.5)
llama-server -m qwen3.5-vision.gguf -c 131072 --port 8080
```

ScrapChat auto-detects vision support from the server's `/props` endpoint and enables image uploads accordingly.

## Development

```bash
# Start dev server with auto-reload
npm run dev

# Watch and rebuild CSS (run in a separate terminal)
npm run css:watch
```

## Built-in Tools

The LLM can autonomously use these tools during conversations:

| Tool | Description |
|---|---|
| `current_datetime` | Returns current date/time with timezone info |
| `web_search` | Searches the web via Tavily (top 5 results) |
| `web_fetch` | Fetches a URL and extracts content as markdown |

Tools are invoked automatically by the LLM when needed — no user action required. Tool usage is shown as collapsible indicators in assistant messages.

## Tech Stack

- **Runtime**: Node.js (ES modules)
- **Framework**: Express v5
- **CSS**: Tailwind CSS v4
- **Frontend**: Vanilla JS (no build step, no framework)
- **LLM Backend**: llama.cpp (OpenAI-compatible API)
- **Web extraction**: Mozilla Readability + Turndown

## License

ISC
