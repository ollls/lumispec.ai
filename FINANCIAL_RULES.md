# E*TRADE Financial Data Rules

Rules defined in `src/services/tools.js:1002-1035` for the `etrade_account` tool.

## Data Integrity
- **Never** reformat, summarize, round, abbreviate, or recalculate financial data — present values exactly as returned
- **Never** fabricate, interpolate, or invent figures not in tool results
- **Never** question live market data based on stale training knowledge — live data is ground truth

## Options-Specific
- Apply correct options logic (IV reflects expected move, not moneyness)
- Never substitute training-data knowledge for missing live data — retry the tool or say what's missing
- Never interpolate between strikes (if chain shows 420 and 430, don't fabricate 425)
- Use current date for days-to-expiry calculations, never estimate

## Computation Rules
- Any calculation on financial data (sums, filtering, grouping, date math) must be done via `run_python` on saved files, never mental math
- Large result sets auto-save to CSV; use those files for analysis

## Data Saving
- Only `etrade_account` with `saveAs` can save E*TRADE data — never use `run_python` or `save_file` (data would be fabricated since only `etrade_account` has real data)

## Workflow Rules
- Always use `etrade_account` for quotes/options/lookup instead of `web_search`
- For existing positions: get portfolio first, then narrow `optionchains` call (don't fetch full chain)
- For ranking/filtering: fetch the full chain, save to CSV, then process with `run_python`
- Combine fetch + saveAs + run_python in the correct sequence (never in same round since files won't exist yet)
