# Demo Prompt Ideas

Prompts designed to showcase multi-tool parallel execution, web search/fetch, and E*TRADE integration.

## 1. Market Research + Live Data (best all-rounder)

```
Compare NVDA and AMD: get their current stock quotes, search the web for the latest earnings reports and analyst outlook for both companies, then summarize which is a better buy right now with supporting data.
```

**Tools triggered:** 2x `quote`, 2x `web_search`, 2x `web_fetch` — parallel execution across tools

## 2. Options Strategy with Context (deep multi-tool)

```
I want to sell covered calls on MU. Get my portfolio to see how many shares I hold, fetch the current MU quote, find available option expiration dates, then search the web for any upcoming MU catalysts or earnings dates. Recommend the best strike and expiry for maximum income with low assignment risk.
```

**Tools triggered:** `portfolio`, `quote`, `optionexpiry`, `optionchains`, `web_search`, `web_fetch`

## 3. Full Account Overview + Market Pulse

```
Give me a complete financial snapshot: list all my E*TRADE accounts with balances, get quotes for NVDA, AMD, MU, AAPL, and MSFT, and search the web for today's top market-moving news. Present everything in a clean dashboard format.
```

**Tools triggered:** `list`, multiple `balance`, `quote` (5 symbols), `web_search`, `web_fetch`

## Notes

- Prompt #2 is the most impressive demo — chains dependent and independent calls, shows parallel execution, and produces actionable recommendations from combined live + web data.
- All prompts benefit from the multi-tool-call support (multiple `<tool_call>` blocks executed in parallel via `Promise.all`).
