# E*TRADE Output Unification

## Problem

E*TRADE API tool (`etrade_account`) had inconsistent output formats across its 14 actions:

1. **`alert_detail` and `transaction_detail`** had no formatters — returned raw nested E*TRADE API JSON directly to the LLM
2. **`_raw` bloat** — all other actions returned `{ _markdown, _raw }` where `_raw` was the entire nested API response (can be 50KB+ for portfolios), wasting LLM context tokens
3. **Inconsistent save summaries** — `saveAs` had ad-hoc summary logic (`transactionCount` vs `recordCount`)

### Return shape inconsistencies (before)

| Action | Had CSV? | Had Md? | LLM received |
|---|---|---|---|
| list, balance, portfolio, transactions, gains | yes | yes | `{ _markdown, _raw }` |
| quote, optionchains, optionexpiry, lookup | yes | yes | `{ _markdown, _raw }` |
| orders, alerts | yes | yes | `{ _markdown, _raw }` |
| **alert_detail** | **NO** | **NO** | **Raw JSON** |
| **transaction_detail** | **NO** | **NO** | **Raw JSON** |

### Return shapes from `etrade.js` (three patterns)

- **Custom wrappers**: `listAccounts`, `getGains`, `getTransactions`, `getQuotes`, `getOptionExpireDates`, `lookupProduct` — return `{ data, totalCount }`
- **Mutated API responses**: `getPortfolio`, `getOrders`, `getAlerts` — return unwrapped API response with injected `totalCount`
- **Raw unwrapped**: `getBalance`, `getOptionChains`, `getAlertDetails`, `getTransactionDetail` — return API response as-is

## Changes

### `src/services/tools.js`

1. **Added 4 new formatters** for previously-unformatted actions:
   - `alertDetailToMd()` — key/value table (Alert ID, Date, Subject, Status, Symbol, Message, etc.)
   - `alertDetailToCsv()` — single-row CSV
   - `transactionDetailToMd()` — key/value table (Transaction ID, Date, Type, Symbol, Amount, etc.)
   - `transactionDetailToCsv()` — single-row CSV

2. **Registered** `alert_detail` and `transaction_detail` in both `formatters` and `mdFormatters` maps — all 14 actions now have consistent formatting.

3. **Replaced `_raw` with `summarize()`** — a lightweight summary extractor that returns only counts/totals per action type:
   - `list` → `{ totalCount }`
   - `balance` → `{ accountId, accountType }`
   - `portfolio` → `{ totalPositions }`
   - `transactions` → `{ totalCount, pagesFetched, queryStartDate, queryEndDate }`
   - `gains` → `{ totalCount, totalGain, totalGainPct }`
   - `quote` → `{ totalCount }`
   - `optionchains` → `{ totalPairs }`
   - `optionexpiry` → `{ totalCount }`
   - `lookup` → `{ totalCount }`
   - `orders` → `{ totalCount }`
   - `alerts` → `{ totalCount }`
   - `alert_detail` → `{ alertId }`
   - `transaction_detail` → `{ transactionId }`

4. **Unified return shape**: every action now returns `{ _markdown: "...", ...summary }` instead of `{ _markdown, _raw }`. The `saveAs` path also uses `summarize()` instead of ad-hoc summary logic.

### `src/routes/conversations.js`

5. **Updated LLM feed logic** (tool result → LLM message): Instead of extracting `_raw` and sending the full API response, it now sends the `_markdown` table (which contains all the data in clean structured format) plus the summary JSON appended after.

## Result

### Unified return shape (after)

All 14 actions now return:
```json
{ "_markdown": "# Title\n| col1 | col2 |\n...", "totalCount": 5 }
```

### What the LLM receives (before vs after)

| Before | After |
|---|---|
| Full nested E*TRADE JSON (can be 50KB+ for portfolios) | Markdown table + `{"totalCount":30}` |
| `alert_detail`: raw `AlertDetailsResponse` JSON | Markdown key/value table |
| `transaction_detail`: raw `TransactionDetailsResponse` JSON | Markdown key/value table |

### Benefits
- Significant LLM context token savings (no more `_raw` payload)
- Consistent output format across all 14 actions
- LLM reasons over the same clean table the user sees in the UI
- `saveAs` summaries are consistent via shared `summarize()` function
