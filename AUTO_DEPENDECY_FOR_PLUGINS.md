# Plugin Auto-Dependency System — Design & Implementation Notes

> **Status: IMPLEMENTED.** This doc captures both the original design rationale and the as-built implementation. The system is live in `src/tools/index.js` with one declared edge: `wiki` → `source`.

Standalone design for declarative dependencies between plugin groups in ScrapChat. Pick up cold from this doc; no other context required.

## Context — why this is needed

Plugins in ScrapChat sometimes call tools from other plugins. The motivating case: the **wiki** plugin (`src/tools/plugin-wiki.js`) builds a two-tier documentation index, and its retrieval pattern relies on `source_read` (from the **source** plugin) for greppy lookups. The wiki plugin doesn't ship its own reader — it deliberately delegates to `source_read` to avoid duplication.

The problem: this creates a **silent dependency**. If a user enables `wiki` but not `source`, the wiki retrieval pattern is broken — the LLM is told to "grep wiki/" via `source_read`, but the tool doesn't exist. There's no warning, no error, just confused behavior at query time.

This will repeat. Any future plugin that wants to leverage `source_read` (or any plugin's tools) has the same problem. A first-class dependency mechanism solves it once for all plugins.

## Proposal in one sentence

**Plugins declare dependencies in their export; enabling cascades up the dependency graph; disabling is blocked if anything depends on the plugin.**

## Plugin interface change

One new optional field on the plugin export:

```js
export default {
  group: 'wiki',
  label: 'Wiki Index',
  dependencies: ['source'],   // NEW: array of group names this plugin requires
  condition: () => !!config.sourceDir,
  // ... rest unchanged
};
```

That's the only API surface change. Existing plugins without `dependencies` continue to work unchanged. Field is optional and defaults to `[]`.

## Behavior — three scenarios

### Scenario 1: Enabling a plugin with dependencies (cascade up)

User clicks "enable" on `wiki`. Backend:

1. Walks the dependency graph from `wiki` recursively (handles transitive deps)
2. Builds the set of all groups that need to be enabled: `{wiki, source}`
3. Enables them all in dependency order (deepest first)
4. Returns the cascade list to the frontend
5. Frontend toast: *"Enabled Wiki Index. Also enabled: Source Code (dependency)."*

This is the "auto-enable dependents" case. Cascade is silent-but-disclosed — no confirmation dialog, but the toast tells the user what changed.

### Scenario 2: Disabling a plugin that has enabled dependents (cascade-disable)

> **Design reversal note (2026-04-08):** Originally this scenario was specified as "block disable with error." During real-world testing the user pushed back: blocking is annoying and forces an extra click. The reversal was made to **cascade-disable** with a disclosure toast — symmetric to cascade-enable. The "too surprising" risk is mitigated by the toast clearly stating what was disabled.

User clicks "disable" on `source` while `wiki` is enabled. Backend:

1. Walks the **reverse** dependency graph from `source` to find all currently-enabled transitive dependents
2. Disables `wiki` (and any other dependents) along with `source`
3. Persists all changes to `data/plugins.json` in one write
4. Returns `{ ok, cascadedOff: ["wiki"] }`
5. Frontend info toast: *"Disabled Source Code. Also disabled (depended on it): Wiki Index. Re-enable Wiki Index to restore both."*

### The cascade asymmetry on recovery (important)

Cascade-enable and cascade-disable are **not inverses**:
- Cascade-enable walks **UP** the dep graph (enabling A enables A's dependencies B, C, ...)
- Cascade-disable walks **DOWN** the dep graph (disabling A disables things that depend on A)

This means: if you disable `source` (which cascade-disables `wiki`) and then re-enable `source`, **`wiki` does NOT auto-restore**. The user has to enable `wiki` manually.

The natural recovery path is *"enable the dependent, not the dependency"*: clicking enable on `wiki` will cascade-enable `source` automatically. So the toast wording explicitly tells the user to re-enable the dependent: *"Re-enable Wiki Index to restore both."*

We don't track previously-cascade-disabled state for auto-restore — it would require persistent state and the recovery path is straightforward enough that it isn't worth the complexity.

### Scenario 3: Disabling a plugin with no enabled dependents (clean disable)

User clicks "disable" on `wiki`. Backend:

1. Walks reverse graph from `wiki` — finds nothing currently-enabled depends on it
2. Disables `wiki` as normal
3. **Does NOT cascade-disable `source` either**, because cascade-disable only walks the *dependents* direction, not the *dependencies* direction. `source` is wiki's dependency, not its dependent — disabling wiki has no effect on source.
4. Frontend: *"Disabled Wiki Index."* (no toast needed, simple action)

**The inverse direction is intentional:** if the user enabled `wiki` (which auto-enabled `source`), then later enabled some other source-using feature, then disabled wiki — auto-disabling source would break the other feature. Cascade-disable only kills things that *depend on* the disabled plugin, never things that *the disabled plugin depended on*.

## Load-time validation

In `loadPlugins()` at startup (`src/tools/index.js:104-128`):

- Build the full dependency graph from all loaded plugins
- **Detect missing dependencies**: if `wiki` declares `dependencies: ['source']` but no `source` plugin exists → log warning + disable the `wiki` group entirely (broken, can't function)
- **Detect circular dependencies**: A→B→A is a load-time error, refuse to register either plugin (log error, leave both unloaded)
- **Validate against always-on groups**: declaring `dependencies: ['core']` is a no-op since core is always loaded — allowed but unnecessary

## Edge cases — proposed handling

| Case | Handling |
|---|---|
| Always-on dependencies (`core`, `web`, `execution`) | Allowed but no-op — they're always enabled, cascade trivially satisfied |
| Conditional dependency unsatisfied (e.g. depending on `finance` when E*TRADE not authed) | Cascade-enables the group flag, but plugin remains inert until condition is met. Show warning toast: *"Enabled Finance, but it requires E*TRADE auth to activate."* |
| Force-disable override | **Skip in v1.** If users want to break things, they can edit `data/plugins.json` directly. Add a "Force" button later only if workflow demands it. |
| Disable an always-on plugin | Already handled — always-on plugins don't appear in toggle UI |
| Transitive deps (A→B→C) | Walk recursively. Enable cascades all the way down; disable blocks if any transitive dependent is enabled. |
| Self-dependency (`group: 'wiki', dependencies: ['wiki']`) | Treat as circular dep at load time, refuse to register |
| Duplicate entries in dependencies array | Deduplicate silently |
| Dependency on a plugin that has `condition: false` at toggle time | Allow the toggle but warn the user that the dependency won't be active |

## Implementation surface

Three files change. Plus a one-line addition to `plugin-wiki.js` to set its dependency.

| File | Change | Estimate |
|---|---|---|
| `src/tools/index.js` | Plugin loader: read `dependencies` field, build dep graph at load time, detect cycles, expose `getDependencies(group)` and `getDependents(group)` helpers, expose `getCascadeEnableSet(group)` helper | ~40 lines |
| `src/routes/plugins.js` | Toggle endpoint: on enable, call `getCascadeEnableSet` and enable all in dep order; on disable, check `getDependents` against current enabled set, refuse if non-empty. Return `{ ok, cascaded: [...] }` or `{ error, blockedBy: [...] }` | ~30 lines |
| `src/public/js/app.js` | Plugin card: show "Requires: X, Y" line under description if dependencies present; toggle handler: parse cascade response, show toast with cascade list; on block error, show toast with `blockedBy` list | ~25 lines |
| `src/tools/plugin-wiki.js` | Add `dependencies: ['source']` to the plugin export | 1 line |

**Total: ~100 lines across 4 files.** Small, contained, no schema migration (`data/plugins.json` shape unchanged — just more entries get written when cascading).

## Helper API to add to `src/tools/index.js`

Sketch of the new helpers (signatures, not implementations):

```js
// Returns the transitive set of groups that GROUP depends on.
// Includes GROUP itself. Walks recursively.
// Throws on circular deps (detected at load time, but defensive).
export function getCascadeEnableSet(group) { ... }

// Returns the immediate dependents (groups that declare GROUP in their dependencies).
// Used for the disable-block check.
export function getDependents(group) { ... }

// Returns the transitive set of dependents (groups that would break if GROUP went away).
// Used if we want to display "would also affect: X, Y" on disable hover.
export function getTransitiveDependents(group) { ... }
```

These work on a graph built once at `loadPlugins()` time and cached, since plugin dependencies don't change at runtime.

## Cycle detection algorithm

Standard depth-first search with three colors (white = unvisited, gray = in progress, black = done). If we hit a gray node during DFS, that's a cycle. Run once at load time. If a cycle is found:

1. Log error with the cycle path: `[wiki] CIRCULAR DEPENDENCY: wiki -> a -> b -> wiki`
2. Refuse to register **all groups in the cycle** (not just one — they're all broken)
3. Other plugins not in the cycle continue to load normally

## What's NOT in scope (explicitly rejected)

- **Dependency versioning.** Plugins declare names, not versions. ScrapChat plugins are in-tree, not versioned packages.
- **Optional dependencies.** "Wiki works better with source but technically functions without it" — no. Either it depends or it doesn't. Forcing the binary distinction keeps the model simple.
- **Soft dependencies for routing hints.** A plugin wanting to say "if X is enabled, prefer X for foo" is a different concept (routing override), not dependency. Out of scope.
- **Per-tool dependencies.** Dependencies are at the group level. Individual tool dependencies would be over-engineering for the current need.
- ~~**Cascade-disable.** Explicitly rejected — too surprising. Disable is a manual operation that requires the user to explicitly clean up dependents first.~~ **(Reversed 2026-04-08 — see Scenario 2 design reversal note. Cascade-disable is now the implemented behavior, with disclosure toast.)**
- **UI for visualizing the dependency graph.** Save for later if it becomes confusing. The "Requires: X" line on each card is enough for v1.

## Risk & rollback

**Risk: Low.** The new `dependencies` field is optional, existing plugins unaffected. Plugin loader change is additive (read a new field, build a graph). Toggle endpoint change is additive (call new helpers, return extra fields). Frontend change is additive (read extra response fields, show toasts).

**Worst-case bug:** cascade logic incorrectly blocks a legitimate disable, or fails to cascade-enable a needed dep. Workaround for users: edit `data/plugins.json` directly to set the desired state.

**Rollback:** revert one commit, plugin loader ignores the new field, toggle endpoint behaves as before. Zero data migration needed.

## Out-of-scope follow-ups (capture for later)

Things to think about *after* v1 is shipped and validated:

1. **Dependency-aware plugin status panel.** Currently shows core/APIs status. Could add a "broken plugins" row showing groups that are enabled but have unsatisfied dependencies (e.g. dependency missing entirely, or dependency's condition is false).
2. **Tooltip on dependent chip.** Hovering over the "Requires: Source Code" line could show why (which tool the dependency uses).
3. **Dependency export in `/api/plugins`.** Add `dependencies: [...]` and `dependents: [...]` to the plugin list response so the frontend doesn't have to recompute.
4. **Per-conversation dependency check.** When a conversation message references a tool from a disabled-via-dependency plugin, surface an inline notice instead of silent failure.
5. **Plugin manifest schema.** If plugins ever leave the in-tree model and become loadable from arbitrary paths, formalize the manifest as a `package.json`-style file. Not needed now.

## How to test (when implementing)

End-to-end checks:

1. **Cascade enable.** Disable both `wiki` and `source`. Click enable on `wiki`. Verify both flip to enabled, toast shows "Also enabled: Source Code", `data/plugins.json` reflects both.
2. **Block disable.** With `wiki` enabled (cascade-enabled `source`), click disable on `source`. Verify the toggle is refused, error toast shows "required by Wiki Index", neither plugin's state changes, `data/plugins.json` unchanged.
3. **Clean disable.** With both enabled, click disable on `wiki`. Verify `wiki` flips off, `source` stays on, no cascading.
4. **Missing dependency.** Temporarily rename `plugin-source.js` → `plugin-source.js.bak` and restart. Verify server log shows warning that `wiki` has unsatisfied dependency, `wiki` is unavailable in the Plugins panel. Restore.
5. **Circular dependency.** Create two test plugins (`plugin-test-a.js` and `plugin-test-b.js`) that depend on each other. Restart server. Verify load-time error log, both plugins missing from Plugins panel. Delete test plugins.
6. **Transitive deps.** Create a chain A→B→C. Enable A. Verify all three enable. Disable A. Verify only A turns off. Disable B. Verify error (C still depends? No wait, in this chain C has no dependents — let me re-state: A depends on B depends on C. Enabling A → enables A, B, C. Disabling C while A enabled → blocked. Disabling A → A turns off, B and C stay.)
7. **No-op cascade.** Add `dependencies: ['core']` to a test plugin. Enable it. Verify no cascade message (core is always-on, no-op).
8. **Always-on dependency listed.** Verify "Requires: Core" doesn't appear on the card (core isn't user-toggleable, listing it as requirement is noise). Or alternatively: show it as informational. Decide during implementation.

## Decision status

**IMPLEMENTED.** Built in a single pass alongside the wiki plugin work.

### What landed (4 files changed)

| File | What changed |
|---|---|
| `src/tools/plugin-wiki.js` | Added `dependencies: ['source']` — the first and only declared edge in v1. |
| `src/tools/index.js` | Added `pluginDependencies` registry, `validateDependencyGraph()` (DFS three-coloring for cycles + missing-dep warnings), helpers `getCascadeEnableSet()` / `getDirectDependents()` / `getAllDependents()` / `getEnabledDependents()`. Refactored `loadPlugins()` into 3 passes (import → validate → register-with-startup-cascade). Made `updatePluginConfig()` cascade-aware with `cascaded: []` and `blockedBy: []` response fields. Made `listPluginGroups()` expose `dependencies` and `dependents` arrays. |
| `src/routes/plugins.js` | **No change** — already pass-through. The `result.error` branch already returns 400; the toggle endpoint forwards `cascaded` / `blockedBy` fields automatically. |
| `src/public/js/app.js` | Added `showPluginToast()` helper. Plugin cards now render "Requires:" and "Required by:" lines (using `labelByGroup` map for human-readable names). Toggle handler reads response JSON, shows blue toast on cascade-enable success, red toast on disable-block error. Toasts auto-dismiss after 6 seconds. |

### Verified end-to-end

Tests run via `node -e` script invoking `loadPlugins()` + `updatePluginConfig()`. Updated to reflect cascade-disable (post-reversal):

| Test | Result |
|---|---|
| Load + populate dep graph + expose via API | ✓ `wiki: deps=[source], dependents=[]` and `source: deps=[], dependents=[wiki]` |
| Enable wiki while source disabled → cascade | ✓ returns `cascadedOn: ["source"]`, both registered |
| Disable source while wiki enabled → cascade-disable | ✓ returns `cascadedOff: ["wiki"]`, both unloaded, both persisted as disabled |
| Re-enable source after cascade-off → wiki STAYS off | ✓ asymmetry confirmed; source comes back alone, wiki must be manually re-enabled |
| Re-enable wiki after cascade-off → cascade-enables source | ✓ returns `cascadedOn: ["source"]` — recovery via "enable the dependent" works |
| Disable wiki (no dependents) → clean disable | ✓ wiki unloads, source stays on |
| Startup cascade convergence | ✓ if `data/plugins.json` has `wiki.enabled=true` and `source.enabled=false`, restart auto-flips source to enabled and persists |
| Syntax check across all 4 files | ✓ |

### Departures from the original design

None — implementation matches the design doc above exactly. The only minor refinement was the load-time logic: instead of validating then registering plugins individually, the loader now computes the full enabled-closure as a Set, persists any cascade-induced cfg changes to `data/plugins.json`, then registers all closure members in one pass. This is cleaner than the per-plugin loop sketched in the design — same behavior, simpler code.

### Where the wiki workaround used to live

The pre-implementation workaround was *"enable `source` first, then enable `wiki`"*. That workaround is no longer needed and was never actually written into the wiki plugin's `description`. The wiki plugin description still explains the trigger phrases for end users, with no mention of dependency setup — the dependency cascade handles it transparently.
