# source_edit Tool — Implementation Plan

## Goal

Enable the LLM to make targeted, surgical edits to source code files without rewriting entire files. This is the critical missing piece for fully functional coding assistance.

## Approaches Considered

### 1. Simple String Replacement (old_string → new_string)
**How it works:** LLM provides an exact string to find and its replacement. The tool locates the string in the file and swaps it.

**Pros:**
- Proven pattern — Claude Code's Edit tool uses this exact approach
- LLM copies text directly from `source_read` output, so matches are reliable
- Simple JSON parameters, easy for the tool call repair infrastructure to handle
- No escaping issues (literal string match, not regex)
- Multiline replacements work naturally

**Cons:**
- old_string must be unique in the file — may need more context to disambiguate
- LLM must reproduce the exact text including whitespace

**Verdict:** ✅ Recommended approach

### 2. Line-Based Editing (line numbers + replacement)
**How it works:** LLM specifies start/end line numbers and the replacement content.

**Pros:**
- Conceptually simple — "replace lines 10-15 with this"
- No uniqueness concerns

**Cons:**
- `source_read` truncates files at ~15,000 characters — LLM may have wrong line numbers
- Line numbers shift after each edit in a multi-edit session
- LLM must count lines accurately (local models are bad at this)
- No way to verify the LLM is replacing what it thinks it's replacing

**Verdict:** ❌ Too fragile for local LLMs

### 3. Hybrid Multi-Edit Arrays
**How it works:** Single tool call with an array of edit operations applied sequentially.

**Pros:**
- Efficient — one call for multiple changes
- Can express complex refactors atomically

**Cons:**
- Complex JSON structure compounds existing tool call parsing fragility
- Conflict detection between edits adds significant complexity
- The tool loop already supports up to 20 rounds and parallel tool calls — multiple single edits achieve the same result
- Harder for LLM to construct correctly

**Verdict:** ❌ Unnecessary complexity, existing multi-round/parallel calling handles this

### 4. Unified Diff / Patch Format
**How it works:** LLM generates a unified diff, tool applies it with patch-like logic.

**Pros:**
- Standard format, expressive
- Can represent multiple hunks in one call

**Cons:**
- Requires precise formatting: line counts in hunk headers, exact context lines
- Local llama models will frequently produce malformed diffs
- Implementing a robust patch parser is significant work
- Error recovery is difficult — a slightly wrong diff just fails

**Verdict:** ❌ Too demanding for local LLM output quality

### 5. Search-and-Replace with Context Lines
**How it works:** Like option 1, but with additional "context before/after" parameters for disambiguation.

**Pros:**
- More robust matching when old_string isn't unique
- Explicit about location

**Cons:**
- More parameters = more ways to get it wrong
- Exact string match with "include more context" achieves the same disambiguation
- Adds complexity without proportional benefit

**Verdict:** ❌ Over-engineered — exact match with uniqueness enforcement is sufficient

## Recommended Design: Exact String Replacement

### Tool Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | yes | Relative file path (e.g. "src/services/tools.js") |
| `old_string` | string | yes* | Exact text to find. Must match exactly one location. Empty = create new file |
| `new_string` | string | yes | Replacement text. Empty string = delete the matched text |

### Core Rules

1. **Uniqueness enforced** — `old_string` must appear exactly once in the file. If it matches 0 or >1 times, the tool returns an error with enough context for the LLM to self-correct.

2. **No `replace_all` flag** — the LLM should be explicit about what it's changing. If it needs to replace multiple occurrences, it calls the tool multiple times. This prevents accidental mass replacements.

3. **Create mode** — when `old_string` is empty and the file doesn't exist, creates the file with `new_string` as content (delegates to the same logic as `source_write`). If the file exists and `old_string` is empty, returns an error.

4. **No-op detection** — if `old_string === new_string`, returns `{ noChange: true }` without writing.

### Whitespace Fallback

If exact match fails (0 matches), the tool attempts a whitespace-normalized match:
- Collapse runs of whitespace (spaces, tabs) to single space in both `old_string` and file content
- If this produces exactly 1 match, apply the edit but report `{ whitespaceAdjusted: true }`
- This handles the common case where the LLM gets indentation slightly wrong (tabs vs spaces, extra indent level)

### Error Messages for Self-Correction

The LLM needs actionable errors to fix its next attempt. Each error includes enough context:

| Scenario | Error Response |
|----------|---------------|
| 0 matches (exact + whitespace) | `{ error: "No match found", hint: "Verify current content with source_read", fileLines: N }` |
| >1 matches | `{ error: "Found N matches — old_string must be unique", matches: [{ line: N, context: "2 surrounding lines" }, ...] }` |
| `old_string === new_string` | `{ noChange: true, message: "old_string and new_string are identical" }` |
| Binary file (null bytes in first 8KB) | `{ error: "Binary file — use source_write for binary content" }` |
| File >1MB | `{ error: "File too large (N bytes) — use run_command with sed for large files" }` |
| `old_string` contains `[truncated]` | `{ warning: "old_string contains a truncation marker — this is not actual file content" }` |
| File not found + non-empty old_string | `{ error: "File not found: path" }` |
| Path escapes source directory | `{ error: "Path escapes source directory" }` |

### Confirmation UX — Diff Preview

Instead of showing just "Edit file: path" in the confirmation prompt, the tool generates a minimal unified-style diff:

```
Edit file: src/services/tools.js
--- src/services/tools.js
+++ src/services/tools.js
@@ lines 710-715 @@
   source_write: {
-    description: 'old text...',
+    description: 'new text...',
   },
```

This reuses the existing `confirmFn` → `confirm_command` SSE event → frontend `<pre>` block rendering. No frontend changes needed — the existing amber-colored pre block with `whitespace-pre-wrap` handles multi-line content.

### Concurrent Edit Safety — Per-File Mutex

The tool loop can execute parallel tool calls. Two `source_edit` calls on the same file would race (read-modify-write). A simple Promise-chain mutex serializes edits per file path:

```javascript
const fileEditLocks = new Map();

async function withFileLock(filePath, fn) {
  const prev = fileEditLocks.get(filePath) || Promise.resolve();
  const current = prev.then(fn, fn);
  fileEditLocks.set(filePath, current);
  try { return await current; }
  finally { if (fileEditLocks.get(filePath) === current) fileEditLocks.delete(filePath); }
}
```

~10 lines, no external dependencies, prevents race conditions.

### What About Undo?

Not needed for the initial implementation. The user already has:
- Diff preview before approving each edit
- Deny option in confirmation prompt
- `source_read` to verify results
- `source_edit` to revert changes manually
- `run_command` with `git checkout`/`git diff` for version control

An undo stack would be premature complexity.

## Implementation Breakdown

### Helper: `simpleDiff(oldContent, newContent, filePath)` — ~25 lines

Generates a minimal diff for the confirmation UI:
- Split old and new content into lines
- Find the changed region (first and last differing lines)
- Show 2 lines of context before/after
- Mark removed lines with `-`, added lines with `+`
- Format with `--- path` / `+++ path` / `@@ @@` headers

Does NOT need to be a valid unified diff parseable by `patch` — it's purely for human review.

### Helper: `withFileLock(filePath, fn)` — ~10 lines

Promise-chain mutex as described above.

### Tool: `source_edit` — ~80 lines

```
execute({ path, old_string, new_string }, context):
  1. Validate: config.sourceDir, path, confirmFn
  2. Resolve path, check escape
  3. If old_string empty:
     a. File doesn't exist → create (mkdir + write), confirm first
     b. File exists → error "old_string required for existing files"
  4. Read file, handle ENOENT
  5. Check for binary content (null bytes in first 8KB)
  6. Check file size (<1MB)
  7. Check old_string === new_string → noChange
  8. Check for [truncated] marker in old_string → warning
  9. Count exact matches of old_string:
     a. 0 → try whitespace-normalized match
        - Still 0 → error with hint
        - 1 → proceed with whitespace adjustment flag
        - >1 → error with match locations
     b. 1 → proceed
     c. >1 → error with match locations
  10. Build new content: content.replace(old_string, new_string)
      (String.replace only replaces first occurrence — and we verified uniqueness)
  11. Generate diff via simpleDiff()
  12. Confirm (or autorun skip): send diff through confirmFn
  13. Write file within withFileLock()
  14. Return { path, linesChanged, size, whitespaceAdjusted? }
```

### System Prompt Update — 1 line

Update Self-Awareness section to mention `source_edit`:
> "Use source_read to review your implementation, source_edit for targeted changes to existing files, and source_write to create or fully replace files."

### CLAUDE.md Update

Add to the Registered Tools table:
> `source_edit` | Edit source files: exact string replacement with uniqueness check and diff preview. Scoped to SOURCE_DIR

## Summary

| Component | Lines | Dependencies |
|-----------|-------|-------------|
| `simpleDiff` helper | ~25 | None |
| `withFileLock` helper | ~10 | None |
| `source_edit` tool | ~80 | None |
| System prompt change | 1 | — |
| CLAUDE.md docs | 1 | — |
| **Total** | **~120** | **Zero new deps** |

All code goes in `src/services/tools.js`. No frontend changes needed. No new npm dependencies.
