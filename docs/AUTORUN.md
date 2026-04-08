# Autorun Feature

Auto-approve Python script execution without user confirmation.

## UI

Checkbox labeled "Autorun" next to the "Applets" checkbox in the input form. Amber accent color (`accent-amber-500`), unchecked by default.

- **HTML**: `src/views/index.html` — `<label id="autorun-toggle-label">` with `<input id="autorun-toggle">`
- **State**: `state.autorunEnabled` in `src/public/js/app.js`, persisted to `localStorage` key `autorunEnabled` (default: `false`)

## Data Flow

1. **Frontend** (`app.js`): Sends `autorun: true|false` in the POST body of `/api/conversations/:id/messages`
2. **Route** (`src/routes/conversations.js`): Extracts `const autorun = !!req.body.autorun` and passes it into every tool execution context object (`context.autorun`)
3. **Tool** (`src/services/tools.js`): `run_python.execute()` checks `context.autorun` — if true, skips the `confirmFn` call and proceeds directly to execution

## Scope

- **`run_python`**: Confirmation skipped when autorun is enabled
- **`run_command`**: Always requires confirmation regardless of autorun state

## Context Object

All tool execution contexts in `conversations.js` include `autorun`:

```js
const context = {
  autorun,
  confirmFn: (command) => {
    res.write(`data: ${JSON.stringify({ confirm_command: { command } })}\n\n`);
    return requestConfirmation(conv.id, command);
  },
};
```

This applies to the main tool loop, forced-answer last-chance execution, and safety-net execution paths.
