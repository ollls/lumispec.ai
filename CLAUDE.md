# LLM Workbench

## Project Overview
Prompt interface with memory management and RAG capabilities. Express-based web app with a dark-themed chat UI.

## Tech Stack
- **Runtime**: Node.js (ES modules)
- **Framework**: Express v5
- **CSS**: Tailwind CSS v4 (CLI build)
- **Frontend**: Vanilla JS, no bundler

## Project Structure
```
src/
  server.js          # Express server, entry point
  routes/prompt.js   # POST /api/prompt (placeholder, no LLM yet)
  views/index.html   # Main chat UI
  public/js/app.js   # Client-side chat logic
  public/css/        # Tailwind input/output
```

## Commands
- `npm run dev` — start dev server with --watch
- `npm start` — start production server
- `npm run css:build` — build Tailwind CSS
- `npm run css:watch` — watch & rebuild Tailwind CSS

## Current State
- Scaffold only — prompt endpoint echoes back input
- No LLM integration, no sessions, no persistence
- Conversation history lives only in browser DOM

## Conventions
- ES modules (`import`/`export`)
- Port defaults to 3000 (configurable via PORT env var)
