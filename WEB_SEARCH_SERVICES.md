# Web Search API Services for LLM Tool Calling

## Current Implementation
DuckDuckGo Lite (`lite.duckduckgo.com/lite/`) — free, no API key, but triggers CAPTCHA blocks on repeated use.

## Paid/Free-Tier API Services

| Service | Free Tier | Credit Card | API Style | Result Quality | Notes |
|---------|-----------|-------------|-----------|---------------|-------|
| **Serper** | 2,500 queries (one-time) | No | REST + API key | Google SERP | Fast (1-2s). Cheapest paid: $50/50k queries. [serper.dev](https://serper.dev/) |
| **Tavily** | 1,000 queries/month | No | REST + API key | AI-optimized | Built for LLM agents. Returns summarized results. [tavily.com](https://tavily.com/) |
| **Jina AI** | No registration needed | No | REST | Good | Search + content extraction in one call. [jina.ai](https://jina.ai/) |
| **SearchAPI** | 100 queries free | No | REST + API key | Google SERP | [searchapi.io](https://www.searchapi.io/) |
| **Brave Search** | Dropped free tier (Feb 2026) | Yes ($5/mo) | REST + API key | Independent index | Privacy-first. ~1,000 queries/mo for $5. [brave.com/search/api](https://brave.com/search/api/) |
| **Firecrawl** | Free tier available | No | REST + API key | Various engines | Returns markdown directly. [firecrawl.dev](https://www.firecrawl.dev/) |

## Self-Hosted Options

| Service | Cost | Setup | Notes |
|---------|------|-------|-------|
| **SearXNG** | Free | Docker container | Aggregates 70+ engines (Google, Bing, Brave, DDG). JSON API. 25.6k GitHub stars. Best long-term solution. [github.com/searxng/searxng](https://github.com/searxng/searxng) |

## Recommendations

- **Best for personal/dev use**: Tavily (1,000/month free, built for LLM agents)
- **Best result quality**: Serper (Google results, 2,500 free to start)
- **Best long-term/unlimited**: SearXNG (self-hosted, no limits, no blocking)
- **Avoid**: Headless browsers (Puppeteer/Playwright) — 400MB+ install, slow, high memory, overkill

## Integration Notes
All API services are a single `fetch` call with an API key header — simpler than DDG scraping. No bot detection issues. API key should be stored in environment variable (e.g. `SEARCH_API_KEY`).
