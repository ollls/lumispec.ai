# Service Library — design and plan

**Status:** proposal, not started. Written 2026-11-10. Work begins after the pending changes
(concurrent conversations, stopped-turn storage, applet fit) are released.

## Goal

Let a plugin carry a library of small, named, reusable data calls — "services" — that the user
builds by asking in chat, sees on the plugin's card, and can run or delete there.

Example request: *"Create a service in the E\*TRADE library that retrieves the SPY value."*
Afterwards the E\*TRADE card lists `spy_quote`; the model can call it by name, and a saved
template can fetch it directly without an LLM turn.

## What a service is

A service is **data, not code**: a saved tool call with fixed arguments, a few declared
parameters, and an optional field selection.

```json
{
  "name": "spy_quote",
  "description": "Current quote for one symbol (default SPY)",
  "tool": "etrade_account",
  "args": { "action": "quotes", "symbols": "{symbol}" },
  "params": { "symbol": { "type": "string", "default": "SPY" } },
  "pick": ["lastTrade", "bid", "ask", "changeClose"],
  "applets": false,
  "createdAt": "2026-11-10T00:00:00.000Z"
}
```

| Field | Meaning |
|---|---|
| `name` | Unique within the group. `[a-z0-9_]+`, also the file name |
| `description` | One line; shown on the card and in the model's service list |
| `tool` | A registered tool of the owning plugin |
| `args` | Arguments for that tool. `{param}` placeholders are substituted from `params` |
| `params` | Declared parameters: `type` (`string` / `number` / `boolean`), optional `default` |
| `pick` | Optional list of result fields to keep (dot paths). Omitted = whole result |
| `applets` | Whether the HTTP endpoint serves this service to applets (default `false`) |

### Why not code

A service written as JavaScript would be LLM-generated code loaded into the server process next
to the E\*TRADE OAuth tokens. A declarative spec can be validated against the tool registry,
shown in full on a card, dry-run before saving, and deleted with no side effects. The local model
also produces a small JSON spec far more reliably than a working module.

Real post-processing (joins, calculations) is deferred to phase 4 and would run as a Python
script through the existing `run_python` path, never in-process.

## Storage

```
data/services/
  etrade/spy_quote.json
  web/reuters_front.json
```

- One folder per plugin group, one file per service. `data/` is already the runtime data dir.
- Web services are stored under `web` even while Browser Search supersedes it — the same
  convention as `web.fetchMaxChars` and the research limits.
- Writes are atomic (`.tmp` + rename) and path-guarded to `data/services/<group>/`.

## Plugin interface

A plugin opts in with one optional field:

```javascript
services: {
  tools: ['etrade_account'],                 // tools a service of this group may call
  allow: (spec) => null | 'reason string',   // plugin-specific veto (e.g. read-only actions)
}
```

The core (`src/services/serviceLibrary.js`, pure where possible) owns loading, validation,
parameter substitution, `pick`, running and deleting. Plugins without `services` are unaffected.

## How the model uses services

Two always-registered tools in a new always-on group, active only when at least one enabled
plugin declares `services`:

- **`service_run { group, name, params? }`** — runs a saved service and returns its result.
- **`service_save { group, name, description, tool, args, params?, pick? }`** — validates,
  dry-runs with the defaults, shows a confirmation preview, then writes the file.
  **Always requires confirmation, including under Autorun** (same stance as `source_project`).

The system prompt carries one short "Saved services" list (`group/name — description`). One
generic tool instead of one tool per service keeps the tool list flat.

**KV cache note:** the list is part of the system prompt, so adding or deleting a service changes
the prefix and the next turn re-reads the whole prompt once. With no services saved the prompt
must stay byte-identical to today's.

## How services get created

No separate builder UI. The flow reuses chat:

1. The user asks in chat for a service.
2. The model runs the real tool call first and checks the result.
3. The model calls `service_save`; the server validates the spec and dry-runs it.
4. The user approves the preview (spec + sample result).

The "service builder console" is a **session colour with a saved session prompt** that explains
the spec format, the allowed tools per group and the run-first rule. That prompt ships as a
suggested text in this doc's follow-up, not as new UI.

## Card UI

A plugin that declares `services` gets a list under its existing controls:

- one row per service: name, description, parameter names
- **Run** — executes with defaults and shows the result inline
- **Delete** — two-click confirmation, removes the file
- no **Add** button; adding happens in chat

Routes:

| Route | Method | Description |
|---|---|---|
| `/api/services` | GET | All services grouped by plugin |
| `/api/services/:group/:name` | GET | Run a service; query string supplies params |
| `/api/services/:group/:name` | DELETE | Delete a service |

## HTTP endpoint for applets and templates

`GET /api/services/etrade/spy_quote?symbol=SPY` returns the service result as JSON. This is the
main payoff: a saved template can refresh its own data with no LLM turn, where today the model
must fetch data and write a file under `/files/` first.

Requests from an applet iframe are served only when the service has `applets: true`. The card's
Run button and `service_run` are not affected by the flag.

## Safety rules

- **E\*TRADE is read-only.** The plugin's `allow` hook accepts quotes, portfolio, balances,
  option chains/expiry and lookups; anything order-related is rejected at save time and again
  at run time.
- **Applet access is opt-in per service.** Applets are model-generated HTML; without the flag
  they cannot read account data through the endpoint.
- **No Tab Fetch through services.** Web services are limited to hidden URL fetches
  (`web_fetch { url, view }`) and `web_search`; `tab` arguments are rejected, so the tab-read
  approval prompt can never be bypassed.
- **Results go through the existing ceiling** (`MAX_TOOL_RESULT_CHARS`) like any tool result.
- **A service whose plugin is disabled or unauthenticated** returns an error naming the reason;
  it is still listed (greyed) on the card.

## Phases

1. **Core + E\*TRADE.** `serviceLibrary.js`, `service_run`, `service_save`, plugin `services`
   field, card list with Run/Delete, read-only `allow` hook in `plugin-etrade.js`. Tests:
   validation, substitution, `pick`, path guard, allow hook.
2. **HTTP endpoint.** `GET /api/services/:group/:name`, the `applets` flag, a card toggle for it.
   Template review audit learns that a `/api/services/` fetch counts as a data source.
3. **Web services.** `services` on `plugin-web.js` / `plugin-browser.js`, tab arguments rejected.
4. **Transforms** — only if phases 1–3 show the need: an optional Python post-processing script
   per service, run through `run_python`.

## Open questions

- Should `service_save` be allowed to overwrite an existing name, or require an explicit delete?
- Do services belong in the task pipeline as a first-class step (`- service: etrade/spy_quote`),
  or is calling them through `service_run` enough?
- Is a per-service `applets` flag enough for finance, or should the endpoint be off for the
  whole `finance` group unless a card switch is turned on?
- Should results be cacheable for a few seconds so a dashboard with several charts does not hit
  E\*TRADE once per chart?
