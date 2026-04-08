# E*TRADE Financial Data Rules

Rules defined in `src/services/tools.js` for the `etrade_account` tool.

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
- Any calculation on financial data (sums, filtering, grouping, date math) must be done via `run_python`, never mental math
- Large result sets (30+ rows) auto-save to CSV in the source project directory; use those files in `run_python`

## Data Saving
- Only `etrade_account` with `saveAs` can save E*TRADE data to the project directory — never use `run_python` to fabricate data (only `etrade_account` has real data)
- Files are saved to the current source project directory (same location where `run_python` executes)

## Workflow Rules
- Always use `etrade_account` for quotes/options/lookup instead of `web_search`
- For existing positions: get portfolio first, then narrow `optionchains` call (don't fetch full chain)
- For ranking/filtering: fetch the full chain, then process with `run_python`
- When `_autoSaved` appears in results, the full data is already saved — use that filename in `run_python`
- Do not mix `optionchains` + `run_python` in the same tool round — files won't exist yet
