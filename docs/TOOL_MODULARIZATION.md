# Tool Prompt Modularization (Implemented)

## Status

**Implemented (with one caveat).** This document originally proposed modularizing the system prompt; the design has since shipped. The system prompt is now dynamically assembled from per-plugin sections at request time. The etrade-specific runtime guards in `conversations.js` (chain continuation, fabrication detector) were *not* physically relocated into `plugin-etrade.js` as Step 5 originally proposed — instead they were gated behind `if (financeEnabled)` (where `financeEnabled = isToolGroupEnabled('finance')`), so they no longer fire when the finance group is disabled. Functionally equivalent for the original goal (no behavior leaks when finance is off), but the code still lives in the route file. The historical plan below is preserved for context.

Current implementation (as of this revision):

- `getSystemPrompt({ applets, precision })` lives in `src/tools/index.js` (around line 514). It dynamically composes the prompt from:
  - `toolList` — only tools not in `disabledTools`
  - `groupSections` — `prompt` field from each plugin whose `isGroupEnabled()` check passes (has at least one enabled tool + any `condition` met)
  - `routingLines` — per-plugin `routing` arrays merged into a single "Tool Routing" section
  - `precisionSection` — `PRECISION_RULES` injected when the precision toggle is on **or** the `finance` group is active
  - Cross-group warnings (e.g. "NEVER use etrade_account for travel") added only when both relevant groups are active
  - `applets` flag gates the applet visualization section
- Plugins are auto-discovered from `src/tools/plugin-*.js` by `loadPlugins()` at server startup. Each plugin exports `group`, optional `label`/`description`/`dependencies`/`condition`/`routing`/`prompt`, and a `tools` map.
- Generic `run_python` rules (vectorized-pandas requirement, 40-line limit, diagnostic-first error handling, "when to use run_python vs direct answer") live in `plugin-execution.js` and are gated on the `execution` group. Finance-specific `run_python` guidance (`saveAs` workflow, option-pair matching example, inline-arithmetic fallback) lives in `plugin-etrade.js` and is gated on the `finance` group. Disabling either group strips its half from the prompt — no entanglement.
- Plugin enable/disable is hot-loadable at runtime via `POST /api/plugins/:group/toggle`, persisted to `data/plugins.json`. Cross-plugin dependencies cascade in both directions (enable walks toward dependencies, disable walks toward dependents).
- Tool-level enable/disable still exists via `POST /api/tools/:name/toggle`, and `getSystemPrompt()` filters the tool list and group activation accordingly.

## Original Problem (historical)

System prompt in `getSystemPrompt()` (tools.js L2009-2245) contained ~240 lines of hardcoded prompt text. Tool-specific sections (financial rules, hotel/travel instructions, source tool workflow, etc.) were always sent to the LLM regardless of which tools were enabled. Disabling a tool via `/api/tools/:name/toggle` only removed it from the "Available tools" list — all behavioral instructions, routing rules, examples, and guardrails remained, wasting context and confusing the LLM.

Additionally, `conversations.js` had etrade-specific runtime behaviors (fabrication detector, chain continuation) that fired even when etrade was disabled.

## Goal (achieved)

When a tool (or tool group) is disabled, ALL associated prompt content and runtime behaviors are excluded — not just the tool list entry.

## Current State Audit

### System prompt sections and their tool dependencies

| Lines | Section | Depends on | Currently conditional? |
|-------|---------|-----------|----------------------|
| 2011-2012 | Core Behavior | none | no (always) |
| 2014-2016 | Current Date and Time | none | no (always) |
| 2017 | User Location | config.location | yes (ternary) |
| 2018 | Self-Awareness / Source workflow | config.sourceDir | yes (ternary) |
| 2020-2024 | File Proxy | none (general) | no (always) |
| 2026-2060 | Tool Call Format + rules | none (general) | no (always) |
| 2038-2044 | Tool call examples | etrade_account | **NO** — hardcoded etrade examples |
| 2046-2050 | JSON nesting examples | etrade_account | **NO** — hardcoded etrade examples |
| 2059 | Booking confirm exception | booking | **NO** — hardcoded |
| 2062-2068 | Tool Routing | mixed (all groups) | **NO** — all routes hardcoded |
| 2070-2130 | Financial Data Integrity | etrade_account | **NO** — 60 lines always sent |
| 2081-2120 | run_python rules | run_python + etrade | **NO** — entangled |
| 2121 | run_command local access | run_command | **NO** — hardcoded |
| 2122 | web_search → web_fetch rule | web_search, web_fetch | **NO** — hardcoded |
| 2123-2130 | etrade vs web_search routing | etrade_account | **NO** — hardcoded |
| 2132-2146 | Hotel & Travel Tools | hotel, travel, booking | **NO** — hardcoded |
| 2147 | "Never claim fabricated" | none (general) | no (always) |
| 2149-2167 | Response Formatting | none | no (always) |
| 2169-2243 | Applet Visualizations | applets flag | yes (ternary) |
| 2244-2245 | Final Reminder | none | no (always) |

### conversations.js runtime behaviors with tool dependencies

| Lines | Behavior | Depends on |
|-------|----------|-----------|
| 274-275 | `hadChainData` / `hadExpiryCall` tracking | etrade_account |
| 434-435 | Track optionchains/optionexpiry calls | etrade_account |
| 440-444 | Directive: "NOW call optionchains" | etrade_account |
| 448-453 | Chain continuation: force optionchains call | etrade_account |
| 455-465 | Fabrication detector: Greeks without data | etrade_account |
| 365-375 | Booking status indicators | booking |

## Design: Tool Groups with co-located prompts

### Data structure

Add a `toolGroups` object in tools.js. Each group defines its member tools, an optional extra condition, and the prompt text to inject when the group is active (at least one member tool enabled + condition met).

```js
const toolGroups = {
  finance: {
    tools: ['etrade_account'],
    prompt: `## Tool Routing — Financial\n...`,
    // Also includes: Financial Data Integrity, options rules, etrade examples
  },
  travel: {
    tools: ['hotel', 'travel', 'booking'],
    prompt: `## Hotel & Travel Tools\n...`,
    // Also includes: booking flow, routing lines, booking confirm exception
  },
  source: {
    tools: ['source_read', 'source_write', 'source_edit', 'source_delete',
            'source_git', 'source_run', 'source_test', 'source_project'],
    condition: () => !!config.sourceDir,
    prompt: `## Self-Awareness\n...`,
  },
  web: {
    tools: ['web_search', 'web_fetch'],
    prompt: `## Web Research\n- After web_search, ALWAYS use web_fetch...`,
  },
  execution: {
    tools: ['run_command', 'run_python'],
    prompt: `## Code Execution\n- You are a LOCAL assistant...`,
    // run_python rules that are NOT etrade-specific (pandas, 40 lines, etc.)
  },
  data: {
    tools: ['save_file', 'list_files', 'file_read'],
    prompt: null,  // no extra prompt needed beyond tool description
  },
  core: {
    tools: ['current_datetime'],
    prompt: null,
  },
};
```

### Helper function

```js
function isGroupEnabled(group) {
  const hasEnabledTool = group.tools.some(t => !disabledTools.has(t));
  const conditionMet = !group.condition || group.condition();
  return hasEnabledTool && conditionMet;
}
```

### System prompt assembly

```js
export function getSystemPrompt({ applets = false } = {}) {
  const toolList = Object.entries(tools)
    .filter(([name]) => !disabledTools.has(name))
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');

  // Collect group prompts
  const groupSections = Object.values(toolGroups)
    .filter(isGroupEnabled)
    .map(g => g.prompt)
    .filter(Boolean)
    .join('\n\n');

  // Build tool routing from enabled groups
  const routingLines = Object.values(toolGroups)
    .filter(isGroupEnabled)
    .map(g => g.routing)        // each group provides its routing line(s)
    .filter(Boolean)
    .flat();

  return `...base template...
${toolList}

${routingLines.length ? `## Tool Routing\n${routingLines.join('\n')}` : ''}

${groupSections}

${applets ? appletSection : ''}
...`;
}
```

## Implementation Steps (completed)

> Steps 1–4 and 6 shipped. The implementation lives in `src/tools/index.js` (registry, assembly, dependency cascade, precision rules) and in the `src/tools/plugin-*.js` files (per-group prompts, routing, tools). Step 5 shipped *partially*: the chain-continuation and fabrication-detector guards in `conversations.js` (lines 287-288, 449-481) were not removed and not moved into `plugin-etrade.js` — instead they are now gated on `isToolGroupEnabled('finance')` so they're inert when the finance plugin is disabled. Relocating them into the plugin remains open work if full code-level decoupling is desired.

## TODO — Step 5 follow-up: relocate finance guards into the plugin

The conditionally-inert finance logic in `conversations.js` is functionally safe (verified: Think mode and all non-finance flows are completely unaffected when `financeEnabled === false`), but it leaves `conversations.js` aware of an etrade-specific concept (`optionchains`/`optionexpiry` actions, Greeks regex). Cleaner design:

1. Define an optional plugin lifecycle hook, e.g. `onToolRound({ toolCallsFound, content, round, llmMessages, state })`, in the plugin interface.
2. Move the tracking variables (`hadChainData`, `hadExpiryCall`), the chain-continuation directive (lines 447-455), the chain-continuation force block (lines 462-469), and the fabrication detector (lines 471-481) into `plugin-etrade.js`. The plugin owns its own per-conversation state.
3. In `conversations.js`, replace the four `if (financeEnabled)` blocks with a generic loop:
   ```js
   for (const plugin of activePlugins) {
     if (plugin.onToolRound) await plugin.onToolRound(ctx);
   }
   ```
4. Result: `conversations.js` is plugin-agnostic, every plugin gets the same extension point, and adding a similar guard for any future plugin (e.g. travel booking sanity checks) requires no route-file edits.

Until this lands, the gating is the correct interim — no behavior leaks, just cosmetic coupling.

### Step 1: Extract prompt text into toolGroups

Move each tool-dependent section from the monolithic template string into the corresponding group's `prompt` field. No behavioral change yet — just reorganize.

Sections to extract:

1. **finance group prompt** — Lines 2066, 2068, 2070-2130
   - Tool routing line for finance
   - Financial Data Integrity block
   - Options reasoning, chain fetching, display rules
   - etrade-specific run_python patterns (saveAs, _autoSaved, transaction analysis examples)

2. **travel group prompt** — Lines 2063-2065, 2068, 2132-2146
   - Tool routing lines for hotel/travel/booking
   - Hotel & Travel instructions
   - Booking flow, rate references, error handling
   - Booking confirm exception (currently in "Tool rules" at L2059)

3. **source group prompt** — Line 2018 (already conditional via config.sourceDir)
   - Self-Awareness section
   - Source tool workflow
   - Just move into group format, keep the config.sourceDir condition

4. **web group prompt** — Lines 2067, 2122
   - Tool routing line for web
   - "After web_search, ALWAYS use web_fetch" rule

5. **execution group prompt** — Lines 2081-2085, 2119-2121
   - run_python code quality rules (the generic ones, not etrade-specific)
   - run_python error handling
   - run_command local access statement
   - "WHEN TO USE run_python vs direct answer" (L2120 — generic part only)

### Step 2: Disentangle run_python rules from etrade content

Lines 2076-2120 mix generic run_python rules with etrade-specific instructions. Split them:

**Generic (stays in `execution` group):**
- run_python code quality (FORBIDDEN iterrows, 40 lines, etc.) — L2081-2085
- run_python error handling (diagnostic first, max 1 retry) — L2119
- WHEN TO USE run_python vs direct answer (generic heuristic) — L2120
- run_command local access — L2121

**etrade-specific (moves to `finance` group):**
- "use run_python for financial calculations, never mental math" — L2076
- "_markdown" table display rule — L2077
- "saveAs" parameter usage — L2078
- "_autoSaved" CSV workflow — L2079-2080
- Transaction analysis pandas examples — L2086-2102
- Option position status definitions — L2103-2117
- Amount column sign rules — L2117
- Critical fallback (inline arithmetic) — L2118

### Step 3: Fix tool call examples

The "Tool Call Format" section (L2026-2060) uses etrade_account in its examples. Two options:

**Option A (recommended):** Use tool-agnostic examples in the base template. Replace etrade examples with generic ones (e.g., `web_search`, `current_datetime`). Each group can include its own examples if needed.

**Option B:** Dynamically pick examples from enabled tools. More complex, less predictable.

### Step 4: Fix Tool Routing section

Currently a single hardcoded block (L2062-2068). Replace with per-group routing lines assembled dynamically. Add a `routing` field to each group:

```js
finance: {
  routing: [
    '- Stock market, portfolio, options, E*TRADE accounts, trading → use "etrade_account" tool',
    '- NEVER use etrade_account for travel/hotel queries. NEVER use hotel/travel for financial queries.',
  ],
},
travel: {
  routing: [
    '- Hotels, travel, trips, vacations, accommodation, resorts → use "hotel" tool',
    '- Weather forecasts, destination info, places, airports, cities → use "travel" tool',
    '- Hotel reservations, booking, cancellation → use "booking" tool',
  ],
},
web: {
  routing: [
    '- Web questions, current events, news → use "web_search" then "web_fetch"',
  ],
},
```

Cross-tool warnings (e.g., "NEVER use etrade for travel") only appear when BOTH groups are enabled. Handle via:
```js
// After collecting routing lines:
if (isGroupEnabled(toolGroups.finance) && isGroupEnabled(toolGroups.travel)) {
  routingLines.push('- NEVER use etrade_account for travel/hotel queries. NEVER use hotel/travel for financial queries.');
}
```

### Step 5: Remove etrade-specific runtime behaviors from conversations.js

Remove the two etrade-specific tool-loop behaviors entirely. They are the only tool-dependent logic outside `getSystemPrompt()`, and dropping them makes the modularization fully declarative — no hardcoded `if (enabled)` branches anywhere.

**What to remove:**

1. **State tracking variables** (L274-275): `hadChainData`, `hadExpiryCall` declarations
2. **Action tracking** (L434-435): `if (tc.arguments?.action === 'optionchains') hadChainData = true` and same for `optionexpiry`
3. **Chain continuation directive** (L440-444): the `if (hadExpiryCall && !hadChainData)` directive appended to tool reminders
4. **Chain continuation force** (L448-453): the block that forces a continuation round when LLM stops after optionexpiry without calling optionchains
5. **Fabrication detector** (L455-465): the block that detects Greeks/strike data in LLM output without a prior optionchains call

Booking status indicators (L365-375) are harmless when booking is disabled (the tool won't be called, so the status check never matches). No change needed.

**Removed behaviors — reference for future restoration:**

> **Chain continuation** (`conversations.js` L448-453): When the LLM fetched `optionexpiry` data (signaling it was doing options analysis) but produced a final answer without ever calling `optionchains`, this guard injected a user message forcing the LLM to continue: *"You have NOT completed the task. You fetched quote/expiry data but did not fetch the option chain data needed for analysis. Call optionchains NOW..."* with a concrete `<tool_call>` example. It also added a mid-round directive (*"NOW call optionchains for the expiries you need"*) to tool result messages when expiry data was present but chain data was not. Purpose: the LLM would sometimes stop after the prep step (quote + expiry) thinking it had enough data, when it actually needed to fetch the chain to get Greeks/premiums.

> **Fabrication detector** (`conversations.js` L455-465): When the LLM's final answer contained patterns matching options data (regex: Greeks like delta/gamma/theta with decimal values, or strike/premium/IV tables) but `optionchains` had never been called in the conversation, this guard injected a corrective message: *"STOP. You are presenting option prices, Greeks, or strike data WITHOUT having fetched real data via the etrade_account tool. This data is fabricated."* Purpose: the LLM would sometimes hallucinate plausible-looking options tables from training data instead of calling the tool.

### Step 6: Move booking confirm exception

Line 2059 in "Tool rules":
```
- EXCEPTION to proactive rule — booking "book" action: ALWAYS stop and confirm...
```

Move this into the `travel` group prompt. It only makes sense when booking is available.

## File Changes Summary

| File | Change |
|------|--------|
| `src/tools/index.js` (formerly logic in `src/services/tools.js`) | Added `toolGroups` registry, `isGroupEnabled()`, `loadPlugins()` auto-discovery, dependency cascade (DFS three-coloring for cycle detection), and refactored `getSystemPrompt()` to assemble dynamically from per-plugin `prompt`/`routing` fields. Tool Call Format examples made tool-agnostic. |
| `src/tools/plugin-*.js` | Per-group plugins (`plugin-core`, `plugin-web`, `plugin-execution`, `plugin-source`, `plugin-travel`, `plugin-etrade`, `plugin-wiki`) own their own `tools`, `prompt`, `routing`, `condition`, and `dependencies`. |
| `src/services/tools.js` | Now a backward-compat barrel that re-exports from `../tools/index.js`. |
| `src/routes/conversations.js` | `hadChainData`/`hadExpiryCall` tracking, chain continuation directive, and fabrication detector are still present (lines 287-288, 449-481) but now gated behind `if (financeEnabled)` so they're inert when the finance plugin is disabled. Not relocated into `plugin-etrade.js`. |

## Testing

1. All tools enabled → system prompt identical to current (minus example tool names)
2. Disable `etrade_account` → no finance section, no etrade routing, no finance examples
3. Disable `hotel` + `travel` + `booking` → no travel section, no booking confirm exception, no travel routing
4. Disable `web_search` + `web_fetch` → no web routing, no "fetch after search" rule
5. Disable all source tools → no self-awareness section (same as no SOURCE_DIR)
6. Re-enable a tool → its group's prompt reappears immediately

## Notes

- The `applets` toggle is per-request (not a tool), so it stays as a parameter to `getSystemPrompt()` — not a tool group.
- `config.sourceDir` and `config.location` are config gates, not tool toggles. Source tools keep both gates: config AND tool-enabled.
- Tool descriptions (in the `tools` object) remain the primary documentation for each tool. Group prompts contain behavioral rules, not tool API docs.
- No file I/O or persistence changes — tool groups are in-memory, same as `disabledTools`.
