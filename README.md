# ScrapChat

A lightweight, self-hosted chat interface for [llama.cpp](https://github.com/ggerganov/llama.cpp) server with `current_datetime`, `web_search`, and `web_fetch` tools. Multi-conversation UI with vision support and real-time slot monitoring — no cloud APIs required for core functionality.

## Features

- **Multi-conversation** — Create, switch, and delete conversations from the sidebar
- **SSE streaming** — Real-time streaming with reasoning model support (Qwen3 `<think>` blocks streamed live into collapsible sections)
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

# Configure
cp .env.example .env
# Edit .env with your settings (LLAMA_URL, TAVILY_API_KEY, etc.)

# Build CSS
npm run build

# Start the server
npm start
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Configuration

Copy the example config and edit it:

```bash
cp .env.example .env
```

All configuration is via environment variables in the `.env` file:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `LLAMA_URL` | `http://localhost:8080` | llama.cpp server URL |
| `LLAMA_MAX_CONTEXT` | `131072` | Fallback max context tokens (auto-detected from server slots) |
| `TAVILY_API_KEY` | — | Tavily search API key (optional, enables web search tool) |

### llama.cpp Server

ScrapChat requires a running [llama-server](https://github.com/ggerganov/llama.cpp/tree/master/examples/server) with any GGUF model. Install llama.cpp and start it:

```bash
# Text-only model
llama-server -m your-model.gguf -c 131072 --port 8080

# Vision-enabled model (e.g., Qwen3.5)
llama-server -m qwen3.5-vision.gguf -c 131072 --port 8080
```

If llama-server runs on a different host or port, set `LLAMA_URL`:

```bash
LLAMA_URL=http://192.168.1.100:8080 npm start
```

ScrapChat auto-detects vision support from the server's `/props` endpoint and enables image uploads when available.

### Tavily Search (optional)

To enable the web search tool, sign up for a free API key at [tavily.com](https://tavily.com) and pass it when starting:

```bash
TAVILY_API_KEY=tvly-your-key-here npm start
```

Without this key, the LLM will still work but won't be able to search the web. The status bar shows a red/green indicator for Tavily availability.

### Full example

```bash
LLAMA_URL=http://localhost:8080 TAVILY_API_KEY=tvly-your-key npm start
```

## Development

```bash
# Start dev server with auto-reload
npm run dev

# Watch and rebuild CSS (run in a separate terminal)
npm run css:watch
```

## Tools

ScrapChat uses a prompt-based tool-calling protocol. The LLM decides when to use a tool, emits a `<tool_call>` XML block, and the backend executes it and feeds the result back. This loop runs up to 5 rounds per message, so the LLM can chain tools (e.g. search then fetch). Tool usage appears as collapsible indicators in assistant messages — no user action required.

### Built-in Tools

#### `current_datetime`

Returns the current date and time in both UTC and local time, plus IANA timezone name and UTC offset. Takes no arguments. The system prompt already includes today's date, but the LLM can call this tool when it needs the exact time.

#### `web_search`

Searches the web via the Tavily API and returns the top 5 results (title, URL, description). Requires `TAVILY_API_KEY` to be set — without it the tool is still registered but calls will fail. The LLM is instructed to use this for any time-sensitive or current-events questions.

**Parameters:** `query` (string)

#### `web_fetch`

Fetches a URL and extracts its main content as clean markdown. Uses Mozilla Readability for article extraction with a Turndown HTML-to-markdown conversion. Output is truncated to ~4 000 characters to keep token usage reasonable. Typically used after `web_search` to read a specific page.

**Parameters:** `url` (string)

### Adding a New Tool

All tools live in a single registry at `src/services/tools.js`. To add a new tool:

**1. Define the tool** — add an entry to the `tools` object:

```js
const tools = {
  // ... existing tools ...

  my_tool: {
    description: 'Short description of what the tool does. Mention required arguments.',
    parameters: { arg1: 'string', arg2: 'number' },
    execute: async ({ arg1, arg2 }) => {
      // Your logic here — can be async
      return { result: 'value' };
    },
  },
};
```

**2. That's it.** The tool is automatically:
- Listed in the system prompt sent to the LLM (built from the registry)
- Parseable and executable by the tool-call loop
- Shown in the UI as a collapsible tool-use indicator when invoked

**Guidelines for tool authors:**
- **`description`** — This is what the LLM reads to decide when and how to call your tool. Be specific about what arguments are required and what the tool returns.
- **`parameters`** — An object mapping argument names to type strings (`'string'`, `'number'`, etc.). Used for documentation; no runtime validation is performed.
- **`execute(args)`** — Receives the parsed arguments object. Return a plain object (it gets `JSON.stringify`'d before being sent back to the LLM). Throw on errors — the framework catches exceptions and returns `{ error: message }`.
- Keep returned data concise. Large payloads eat into the model's context window.
- Use `AbortSignal.timeout()` for any external HTTP calls to avoid hanging the tool loop.

## Tech Stack

- **Runtime**: Node.js (ES modules)
- **Framework**: Express v5
- **CSS**: Tailwind CSS v4
- **Frontend**: Vanilla JS (no build step, no framework)
- **LLM Backend**: llama.cpp (OpenAI-compatible API)
- **Web extraction**: Mozilla Readability + Turndown

## License

ISC
