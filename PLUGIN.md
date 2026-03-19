# Plugin Architecture Planning

## Current State

Backend (`src/services/tools.js`, 1850 lines) is monolithic — all 13 tools defined in single object, system prompt hardcoded with ~200 lines of tool-specific instructions. Frontend (`src/public/js/app.js`) is ~95% generic already; only E*TRADE has dedicated UI (~85 lines for OAuth).

## Where Plugins Would Help

### 1. Backend Tool Definitions — High Value
The `tools` object + system prompt rules are the biggest monolith. Each tool becomes a self-contained module:
```
src/tools/etrade.js      // definition + formatters + system prompt rules
src/tools/hotel.js       // definition + formatters + system prompt rules
src/tools/web_search.js  // etc.
```
Execution logic, CSV/markdown formatters, and system prompt instructions are all interleaved in one file today.

### 2. System Prompt Composition — High Value
Currently hardcoded in `getSystemPrompt()`. Each plugin registers its own prompt section, assembled at runtime. Adding/removing tools becomes clean — disabled tools don't inflate the prompt.

### 3. Service Status Indicators — Medium Value
E*TRADE auth panel, LiteAPI status dot, search engine status all follow same pattern (poll endpoint, show dot/label) but are coded individually. A generic "service status" plugin pattern would reduce repetition.

## Where It Would NOT Help

### 4. Frontend Tool Result Rendering — Low Value
Already generic. All tools use same pipeline (`_markdown` tables, image extraction, file download links). Backend does the formatting. No tool-specific rendering cards exist.

### 5. Applet System — No Value
Already cleanly separated and tool-agnostic. Prompt-based, works with any tool output. Good model for how plugins could work.

## Plugin Interface (Sketch)

Each tool plugin exports:
```javascript
export default {
  name: 'etrade_account',
  description: '...',
  parameters: { /* ... */ },
  execute: async (args, context) => { /* ... */ },

  // System prompt rules injected when tool is enabled
  systemPromptRules: `## E*TRADE Data Integrity\n...`,

  // Optional frontend panel (e.g., OAuth flow)
  frontendPanel: { /* config or path */ },

  // Optional service health check
  healthCheck: { endpoint: '/api/etrade/status', label: 'E*TRADE' },
}
```

## Pain Points Solved
- Adding a new tool currently requires editing 1850-line `tools.js` + hardcoding system prompt rules
- Removing/disabling a tool still loads all its code and prompt bloat
- Tool-specific instructions inflate system prompt even when tools are disabled
- E*TRADE formatters (~100 lines), LiteAPI formatters, etc. clutter the shared file

## Implementation Order (Suggested)
1. Create `src/tools/` directory, extract one simple tool (e.g., `current_datetime`) as proof of concept
2. Build plugin loader that auto-discovers `src/tools/*.js` modules
3. Migrate system prompt rules into each plugin's `systemPromptRules` export
4. Extract remaining tools one by one (start with isolated ones, save E*TRADE for last)
5. Wire up `disabledTools` to skip loading prompt rules for disabled tools
6. Optional: generic service status handler for frontend panels
