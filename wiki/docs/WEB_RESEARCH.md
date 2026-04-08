---
source: file:docs/WEB_RESEARCH.md
last_updated: 2026-04-08T16:28:31.197Z
tags: [web-research, search-engines, tavily, keiro, duckduckgo, fetch-modes, puppeteer, content-extraction]
answers:
  - "Which search engines are available in the LLM Workbench web research pipeline?"
  - "What are the differences between regular, stealth, and browser fetch modes?"
  - "How do I configure the web plugin to use specific search engines?"
  - "What are the requirements for enabling browser mode with Puppeteer?"
  - "How does the system handle content extraction and HTML to Markdown conversion?"
---
# Web Research System Configuration

The LLM Workbench web research pipeline integrates three distinct search engines—Tavily, Keiro, and DuckDuckGo—with three configurable fetch modes: regular, stealth, and browser. Tavily offers AI-optimized summarization, Keiro provides structured proprietary results, and DuckDuckGo enables privacy-focused scraping without API keys. Fetch modes range from fast native `fetch()` for static sites to full Puppeteer-based browser automation for JavaScript-heavy applications, with stealth mode serving as the default balance of speed and bot detection evasion. The system manages parallel engine execution, deduplicates results by URL, and processes content through a Readability.js and Turndown pipeline to generate truncated Markdown output. Configuration is handled via `data/plugins.json`, allowing users to define engine arrays and select the appropriate mode based on target site complexity and anti-bot measures.

## Key topics
- Search engines — Tavily, Keiro, and DuckDuckGo with specific API requirements and use cases
- Fetch modes — Regular, stealth (got-scraping), and browser (Puppeteer) trade-offs
- Configuration — Plugin settings in `data/plugins.json` for enabling engines and modes
- Content pipeline — HTML-to-Markdown conversion using Readability.js and Turndown
- Error handling — Strategies for timeouts, layout changes, and API authentication failures
- Troubleshooting — Resolving Chrome dependencies and mode-specific limitations