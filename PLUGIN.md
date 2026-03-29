# Plugin Architecture

## Overview

The tool system uses a per-group plugin architecture. Each plugin is a self-contained ES module that exports tool definitions, system prompt sections, routing hints, and optional activation conditions. A core index handles auto-discovery, registration, and shared infrastructure.

## File Structure

```
src/tools/
  index.js              Core: loader, registry, executor, parser, logging, confirmation, system prompt assembly
  plugin-core.js        current_datetime
  plugin-web.js         web_search, web_fetch + Tavily/Keiro search backends
  plugin-execution.js   run_python
  plugin-source.js      source_read, source_write, source_edit, source_delete, source_git, source_run, source_test, source_project, template_save + file locks, diff helpers
  plugin-travel.js      hotel, travel, booking + rate map cache, guest profile persistence
  plugin-etrade.js      etrade_account + 20 CSV/Markdown formatters, summarize helpers

src/services/tools.js   Backward-compat barrel (re-exports from ../tools/index.js)
```

## Plugin Interface

Each `plugin-*.js` file exports a default object:

```javascript
export default {
  group: 'web',                              // group name (used in toolGroups registry)
  condition: () => true,                     // optional: group only active when true
  routing: ['- Web questions → web_search'], // LLM routing hints for tool selection
  prompt: '## Web Research\n...',            // system prompt section (injected when group active)
  tools: {
    web_search: {
      description: 'Search the web...',
      parameters: { query: 'string' },
      execute: async ({ query }) => { /* ... */ },
    },
    web_fetch: { /* ... */ },
  },
};
```

## Core Index (`src/tools/index.js`)

### Auto-Discovery
`loadPlugins()` reads all `plugin-*.js` files from the tools directory, registers their tools and groups. Called once at startup from `src/server.js` before `app.listen()`.

### Shared Infrastructure
- **Registry**: `tools` map (name → definition), `toolGroups` map (group → metadata)
- **Enable/disable**: `disabledTools` Set, `listTools()`, `setToolEnabled()`
- **Group helpers**: `isGroupEnabled()`, `isToolGroupEnabled()`
- **System prompt**: `getSystemPrompt({ applets })` — assembles from enabled groups
- **Parsing**: `parseToolCalls()`, `repairToolCallJson()` — extracts tool calls from LLM output
- **Execution**: `executeTool()` — executor with fuzzy matching, logging, error handling
- **Logging**: `logToolCall()` — daily log files in `logs/`
- **Confirmation**: `requestConfirmation()`, `resolveConfirmation()`, `cancelConfirmation()` — queue-based user approval

### Exported Helpers (for plugins)
- `fixPythonBooleans(code)` — auto-fix JS-style booleans/null → Python
- `tagLineCount(stdout, limit)` — truncate + line count annotation
- `logToolCall(name, action, data)` — used by etrade plugin for internal logging

## Tool Groups

| Group | Plugin | Tools | Condition |
|-------|--------|-------|-----------|
| core | plugin-core.js | `current_datetime` | — |
| web | plugin-web.js | `web_search`, `web_fetch` | — |
| execution | plugin-execution.js | `run_python` | — |
| source | plugin-source.js | 8 source tools + `template_save` | `config.sourceDir` set |
| travel | plugin-travel.js | `hotel`, `travel`, `booking` | — |
| finance | plugin-etrade.js | `etrade_account` | `etrade.isAuthenticated()` |

Cross-group warnings (e.g. finance + travel both active) are handled in `getSystemPrompt()` in the core index.

## Backward Compatibility

`src/services/tools.js` is a thin barrel that re-exports everything from `../tools/index.js`. Consumers (`routes/conversations.js`, `routes/tools.js`, `routes/taskProcessor.js`) import from `services/tools.js` unchanged.

## Adding a New Tool

1. Create `src/tools/plugin-mytool.js` following the interface above
2. The loader auto-discovers it on next server start
3. No changes needed to routes, index, or barrel

## Design Decisions

- **Per-group, not per-tool**: Tools in a group share state, formatters, and imports. Splitting into individual files would create excessive cross-file coupling.
- **Formatters with their tool**: E*TRADE's 20 formatters are only used by `etrade_account`. Generic helpers (`csvEscape`, `toCsv`, `toMd`) live with the etrade plugin as the sole consumer.
- **Shared state stays in the plugin**: `fileEditLocks` in source, `lastRateMap`/`lastPrebookId` in travel — each plugin owns its state.
- **Cross-group warnings in core**: They're inherently cross-cutting and belong in the assembler, not individual plugins.
