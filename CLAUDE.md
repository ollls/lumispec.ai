# LLM Workbench

## Project Overview
Multi-conversation chat interface connected to a local llama-server. Express-based web app with a dark-themed chat UI, SSE streaming, and slot management.

## Tech Stack
- **Runtime**: Node.js (ES modules)
- **Framework**: Express v5
- **CSS**: Tailwind CSS v4 (CLI build)
- **Frontend**: Vanilla JS, no bundler
- **LLM Backend**: llama.cpp server (OpenAI-compatible `/v1/chat/completions` endpoint)

## Project Structure
```
src/
  config.js                # Centralized config (port, llama URL, context size)
  server.js                # Express server, entry point, starts slot polling
  routes/
    conversations.js       # CRUD + POST /:id/messages (SSE streaming)
    slots.js               # Slot status, pin/unpin endpoints
    health.js              # Health check proxy to llama-server
  services/
    conversations.js       # In-memory conversation store (Map-based)
    llm.js                 # llama-server client (streaming, non-streaming, SSE parser)
    tools.js               # Tool registry, system prompt, parser, executor
    slots.js               # Slot monitor (polling, assignment, pin/unpin)
  views/index.html         # Main chat UI (sidebar, status bar, slot panel)
  public/js/app.js         # Client-side: conversations, streaming, slots UI
  public/css/              # Tailwind input/output
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
| `/api/slots` | GET | Slot status enriched with conversation mapping |
| `/api/slots/pin` | POST | Pin conversation to slot |
| `/api/slots/unpin` | POST | Unpin conversation from slot |
| `/api/health` | GET | llama-server health proxy |

## Commands
- `npm run dev` — start dev server with --watch
- `npm start` — start production server
- `npm run css:build` — build Tailwind CSS
- `npm run css:watch` — watch & rebuild Tailwind CSS

## Environment Variables
- `PORT` — server port (default: 3000)
- `LLAMA_URL` — llama-server base URL (default: `http://localhost:8080`)
- `LLAMA_MAX_CONTEXT` — fallback max context tokens (default: 131072, overridden by slot `n_ctx`)

## Current State
- Connected to local llama-server via OpenAI-compatible chat completions endpoint
- Prompt-based tool calling: system prompt defines `<tool_call>` protocol, backend loops up to 5 rounds executing tools and feeding results back until LLM produces a final answer
- Tool-call rounds are buffered (non-streaming); final answer sent as single SSE `{content}` event
- Client shows collapsible tool-use indicators (`{tool_use}` SSE events) in assistant bubbles
- Available tools: `current_datetime` (returns UTC, local time, IANA timezone, UTC offset)
- SSE streaming with support for reasoning models (Qwen3 `reasoning_content`)
- In-memory conversation store (no persistence across restarts)
- Slot monitoring with bidirectional conversation-slot mapping
- Context bar reads actual `n_ctx` from llama-server `/slots` endpoint
- Health polling (5s) and slot polling (3s)
- Auto-creates conversation on first message if none selected

## Conventions
- ES modules (`import`/`export`)
- Port defaults to 3000 (configurable via PORT env var)
- llama-server sends `timings` (not OpenAI `usage`) — backend normalizes to `usage` format
- Tools are registered in `src/services/tools.js` — add new tools to the `tools` object with `description`, `parameters`, and `execute` function
- Tool results sent to LLM as `user` role messages: `Tool "name" result: {json}`
