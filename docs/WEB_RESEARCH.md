# Web Research System

## Overview

LLM Workbench provides a sophisticated web research pipeline with three search engines and three fetch modes, configurable per-task.

---

## Search Engines

### 1. Tavily

**Best for:** AI-optimized queries, content extraction

- API-based search with built-in content summarization
- Returns structured results with extracted content
- Requires `TAVILY_API_KEY` in `.env`
- Max 5 results per query
- 15-second timeout

```json
{
  "query": "latest AI developments 2026",
  "max_results": 5
}
```

### 2. Keiro

**Best for:** Structured results, proprietary backend

- Custom search API with snippet extraction
- Returns `search_results` array with title, URL, snippet
- Requires `KEIRO_API_KEY` and `KEIRO_BASE_URL`
- 15-second timeout

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
- Falls back gracefully if layout changes

**Limitation:** Requires stealth or browser mode (not available in regular mode)

---

## Fetch Modes

### 1. Regular Mode

**Speed:** ⚡ Fastest  
**JavaScript:** ❌ No  
**Bot Detection:** ❌ Easily blocked

Uses native `fetch()` with custom User-Agent:

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

- `"regular"` — Native fetch only
- `"stealth"` — got-scraping (default)
- `"browser"` — Full Puppeteer

### Engine Arrays

Order matters for single-engine fallback. For multi-engine:
- All available engines run in parallel
- Results merged and deduplicated by URL
- Up to 8 unique results returned

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

### Failover

If Tavily fails but Keiro succeeds, only Keiro results returned with `sources: "Keiro"`.

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

- Timeouts fall back to partial content (browser mode)
- Navigation errors re-thrown
- Cloudflare blocks reported to user

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
