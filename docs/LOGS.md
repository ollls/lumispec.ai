# Tool Call Logs

## Overview
Every tool call is logged with full details: timestamp, tool name, arguments, raw result, and the formatted result sent to the LLM. Logs are stored in `logs/` with one file per day.

## Log Files
- Location: `logs/tools_YYYY-MM-DD.log`
- Created automatically on first tool call of the day
- No rotation or compression — files accumulate, delete old ones manually

## Entry Format
Each entry contains:
```
════════════════════════════════════════
[2026-03-28T20:30:18.791Z] source_run:call
────────────────────────────────────────
ARGS: {"command":"ls -la ./logs/"}
─── RAW ───
{ full result object }
─── FORMATTED (to LLM) ───
{ result as sent to LLM context }
```

## What Gets Logged
Every registered tool call, including:
- **Web**: `web_search` queries/results, `web_fetch` content extraction
- **Shell**: `source_run` commands and output, `run_python` scripts and output
- **Source code**: `source_read` (tree/read/grep), `source_write`, `source_edit`, `source_delete`
- **Git**: `source_git` commands (status, diff, commit, etc.)
- **Project**: `source_project` switches, resets, status checks
- **Finance**: `etrade_account` queries (quotes, chains, portfolio, orders)
- **Travel**: `hotel`, `travel`, `booking` searches and reservations
- **Core**: `current_datetime` calls

## What You Can Query
- What searches were performed and what results came back
- What commands ran, their exit codes, stdout/stderr
- What files were read or modified (with diffs)
- What data was fetched (quotes, hotel rates, etc.)
- When activity happened (timestamps on every entry)
- What failed and why (errors preserved in raw results)

## Example Questions
- "What web searches did I run today?"
- "Show me all file edits from yesterday"
- "What commands failed today?"
- "List all Python scripts executed this week"
- "What E*TRADE data was queried?"
