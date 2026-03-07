# `web_fetch` Tool — Implementation Plan

## Step 1: Install dependencies

```bash
npm install @mozilla/readability linkedom turndown
```

Three lightweight packages, all ESM-compatible, 1M–2M+ weekly downloads each.

## Step 2: Add `web_fetch` tool to `src/services/tools.js`

Add imports at the top:

```js
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
```

Add to the `tools` object after `web_search`:

```js
web_fetch: {
  description: 'Fetch a web page and extract its content as markdown. Requires a "url" argument.',
  parameters: { url: 'string' },
  execute: async ({ url }) => { ... },
}
```

The execute function will:
1. `fetch(url)` with a browser-like User-Agent and 10s timeout
2. Parse HTML with `linkedom`
3. Try `Readability` to extract article content
4. If Readability succeeds → convert extracted `content` HTML to markdown via `turndown`
5. If Readability fails (non-article page) → strip `script/style/nav/footer/header/aside` from raw HTML, then convert with `turndown`
6. Truncate output to ~4000 chars to keep token usage reasonable
7. Return `{ url, title, content }`

## Step 3: Update `CLAUDE.md`

Add `web_fetch` to the available tools list in the Current State section.

## Step 4: No changes needed elsewhere

- `executeTool` is already async (from `web_search` work)
- `conversations.js` route already uses `await executeTool()`
- The tool loop (5 rounds max) already supports multi-step: LLM can call `web_search` first, then `web_fetch` on a result URL

## Files touched

- `package.json` — 3 new dependencies
- `src/services/tools.js` — add `web_fetch` tool + imports
- `CLAUDE.md` — document new tool
