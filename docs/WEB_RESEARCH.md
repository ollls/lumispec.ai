# Web Research System

## Overview

LLM Workbench provides a sophisticated web research pipeline with three search engines and three fetch modes, configurable per-task.

---

## Search Engines

> The user-facing `web_search` tool only accepts a `query` argument (`src/tools/plugin-web.js:215`). The JSON shapes shown below for Tavily and Keiro are the **backend HTTP request bodies** the plugin sends to the upstream APIs — they are not tool invocation arguments. Engine-specific options like `max_results` or `apiKey` are wired into the backend code and cannot be overridden from a tool call.

### 1. Tavily

**Best for:** AI-optimized queries, content extraction

- API-based search; results carry both snippet and `content` fields
- Requires `TAVILY_API_KEY` in `.env` (`src/tools/plugin-web.js:63`)
- Hard-coded `max_results: 5` per query (`src/tools/plugin-web.js:65`)
- 15-second timeout (`src/tools/plugin-web.js:66`)

Backend request body (sent by `searchTavily`, not by the user):

```json
{
  "query": "latest AI developments 2026",
  "max_results": 5
}
```

### 2. Keiro

**Best for:** Structured results, proprietary backend

- Custom search API with snippet extraction
- Returns `search_results` array with title, URL, snippet (`src/tools/plugin-web.js:90`)
- Requires `KEIRO_API_KEY` and `KEIRO_BASE_URL`
- 15-second timeout
- Plugin slices to first 5 results (`src/tools/plugin-web.js:91`)

Backend request body (sent by `searchKeiro`, not by the user):

```json
{
  "apiKey": "your_key",
  "query": "quantum computing news"
}
```

### 3. DuckDuckGo

**Best for:** Privacy-focused, no API key

- Scrapes HTML from `html.duckduckgo.com`
- Uses `got-scraping` for realistic headers
- No API key required
- Parses `.result` elements for title, URL, snippet
- If parsing yields zero results (layout change or block), returns `{ error: 'No results parsed (DDG may have changed layout or blocked)', results: [] }` (`src/tools/plugin-web.js:119-122`). This is detection + reporting, not a fallback to an alternate parsing strategy.

**Limitation:** Skipped entirely if `mode` is `regular` — requires `stealth` or `browser` mode because the parser depends on `got-scraping` (`src/tools/plugin-web.js:219-225`).

---

## Fetch Modes

### 1. Regular Mode

**Speed:** ⚡ Fastest  
**JavaScript:** ❌ No  
**Bot Detection:** ❌ Easily blocked  
**Timeout:** 10 seconds (`src/tools/plugin-web.js:137`)

Uses native `fetch()` with custom User-Agent (`src/tools/plugin-web.js:133-138`):

```javascript
headers: {
  'User-Agent': 'Mozilla/5.0 (compatible; LLM-Workbench/1.0)'
}
```

**Best for:** Static HTML pages, APIs, simple sites

### 2. Stealth Mode (Default)

**Speed:** ⚡️ Fast  
**JavaScript:** ❌ No  
**Bot Detection:** ✅ Bypasses basic detection

Uses `got-scraping` library with:
- Rotated User-Agent strings (Chrome/Linux desktop)
- Realistic header fingerprints
- 15-second timeout

```javascript
headerGeneratorOptions: {
  browsers: ['chrome'],
  operatingSystems: ['linux'],
  devices: ['desktop']
}
```

**Best for:** Most websites, news articles, documentation

### 3. Browser Mode

**Speed:** 🐌 Slowest  
**JavaScript:** ✅ Full support  
**Bot Detection:** ✅ Best protection

Full Puppeteer + StealthPlugin integration:
- Launches headless Chrome/Chromium
- Waits for `networkidle2` (with 15s timeout fallback)
- Executes all JavaScript
- Handles long-polling sites gracefully

**Requirements:**
- Chrome/Chromium installation
- `puppeteer-extra` + `puppeteer-extra-plugin-stealth`
- `CHROME_PATH` env var if non-standard location

**Best for:** React/Vue apps, heavily protected sites, dynamic content

---

## Configuration

### Plugin Config (`data/plugins.json`)

The shipped default is a **single engine** — Keiro — with stealth mode (`src/tools/plugin-web.js:46, 204`):

```json
{
  "web": {
    "enabled": true,
    "mode": "stealth",
    "engines": ["keiro"]
  }
}
```

To use multiple engines in parallel, list them all:

```json
{
  "web": {
    "enabled": true,
    "mode": "stealth",
    "engines": ["keiro", "tavily", "duckduckgo"]
  }
}
```

### Mode Values

- `"regular"` — Native `fetch()` only (DuckDuckGo is skipped in this mode)
- `"stealth"` — got-scraping (default)
- `"browser"` — Full Puppeteer

### Engine Arrays — what actually happens

Behavior depends on how many engines are in the array:

**Single engine** (`src/tools/plugin-web.js:231-238`):
- Runs that one engine.
- If it fails (HTTP error, parse error, network error), the user gets `{ error, results: [] }`.
- **There is no fallback to other engines.** Order in a single-element array is meaningless.

**Multiple engines** (`src/tools/plugin-web.js:241-266`):
- All engines run in parallel via `Promise.all`.
- If some engines fail and others succeed, the survivors' results are still returned. This is graceful degradation, not failover — there is no primary/backup relationship and no automatic retry of a failed engine against a different one.
- Results are concatenated in engine iteration order, then deduplicated by URL (first occurrence wins).
- The merged list is sliced to the **first 8** unique results (`src/tools/plugin-web.js:266`).
- **No relevance ranking, scoring, or re-ordering of any kind.** Order is purely "whichever engine's results came first in the iteration."

---

## Usage Patterns

### Single Engine (Fastest)

```json
{"engines": ["tavily"]}
```

### Multi-Engine (Most Comprehensive)

```json
{"engines": ["keiro", "tavily", "duckduckgo"]}
```

Results from all engines merged, deduplicated, limited to 8.

### Graceful degradation in multi-engine mode

If Tavily fails but Keiro succeeds, the response contains Keiro's results and `sources: "Keiro"` (i.e. only the engines that produced results are listed in `sources`). The failed engine is logged via `console.warn` but not surfaced in the response. This is *not* a failover — Tavily is not retried, and there is no chained substitution. It's just "whoever returned data, their data is what you get."

---

## Content Extraction

### HTML to Markdown Pipeline

1. **Readability.js** — Extract main article content
2. **Turndown** — Convert HTML to Markdown
3. **Fallback** — If no article found, strip nav/footer/header

### Output Limits

- Max 4000 characters
- Truncated content appended with `[...truncated]`
- Title extracted from `<title>` or Readability

---

## Error Handling

### Search Failures

- HTTP errors logged with status code
- Empty results return `{ error: "...", results: [] }`
- DDG layout changes detected and reported

### Fetch Failures

- **Browser mode `networkidle2` timeout**: caught and falls back to whatever HTML loaded by the timeout (`src/tools/plugin-web.js:159-166`). Useful for long-polling sites that never settle.
- **Other navigation errors** in browser mode: re-thrown (no fallback).
- **Cloudflare and other anti-bot challenge pages**: not detected by the code. The fetch helpers return whatever HTML the request produces — if a Cloudflare challenge page comes back, the LLM sees it as content and is expected to recognize it (the plugin's system prompt at `src/tools/plugin-web.js:208-211` instructs the LLM to fall back to search snippets when fetched content looks like a block). There is no code-level Cloudflare detection or user-facing alert.

---

## Best Practices

1. **Always search first**, then fetch most relevant result
2. **Use stealth mode** for general web research
3. **Reserve browser mode** for JavaScript-heavy sites
4. **Don't retry blocked sites** — move to next result
5. **Max 3 searches + 3 fetches** per question
6. **Check API keys** before enabling Tavily/Keiro

---

## Troubleshooting

### "No Chrome/Chromium found"

```bash
# Linux
sudo apt install google-chrome-stable

# Set custom path
export CHROME_PATH=/usr/bin/chromium-browser
```

### "DDG skipped — requires stealth or browser mode"

Change mode from `regular` to `stealth` or `browser`.

### "Tavily returned HTTP 401"

Check `TAVILY_API_KEY` in `.env` is valid.

### Slow fetch times

- Switch from `browser` to `stealth` mode
- Reduce `engines` array to single fastest engine

---

## Performance Comparison

| Mode | Speed | JS Support | Anti-Bot | Dependencies |
|------|-------|------------|----------|--------------|
| Regular | ⚡⚡⚡ | ❌ | ❌ | null |
| Stealth | ⚡⚡ | ❌ | ✅ | got-scraping |
| Browser | ⚡ | ✅ | ✅✅ | Puppeteer + Chrome |

---

*For implementation details, see `src/tools/plugin-web.js`*
