# Obsidian export — plan

**Status:** planned, not started. Written 2026-10-25.

## Goal

Lumispec conversations appear as notes in an Obsidian vault, in a folder of their own, kept
current while a conversation is pinned, with the conversation's metadata as Obsidian properties
and the tool work folded away in callouts. No plugin on the Obsidian side; Obsidian watches its
vault folder and picks the files up on its own.

This is a **one-way translation**, not a sync and not a copy. Lumispec's own store (in-memory
`Map` + `data/pinned/<id>.json`) stays the source of truth; the vault holds a rendered view that
is regenerated from scratch on every change. Edits made in Obsidian are overwritten on the next
regeneration — annotate in a separate note that links to the exported one.

## Configuration (one new plugin card, almost nothing to type)

Obsidian registers every vault it has opened in a JSON file the server can read:

| Install | Registry |
|---|---|
| native / AppImage / deb | `~/.config/obsidian/obsidian.json` |
| Flatpak | `~/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json` |
| Snap | `~/snap/obsidian/current/.config/obsidian/obsidian.json` |

`vaults: { <id>: { path, ts, open? } }`. On this machine: `/home/ols/obsidian_vault` and
`/home/ols/MULTINET` (Flatpak, currently open).

Plugin `obsidian` (`src/tools/plugin-obsidian.js`, off by default, `cardStatus()` shows the
resolved vault path or "no vault found"), persisted in `data/plugins.json` under `obsidian`:

| Setting | Where | Default |
|---|---|---|
| Vault | dropdown of registry paths on the card; `.env` `OBSIDIAN_VAULT=<path>` overrides (vault on a share, or a server without Obsidian) | the registry's `open` vault, else the most recently used |
| Folder inside the vault | text field | `Lumispec` |
| Auto-export pinned conversations | toggle | on |
| Include tool results | toggle | on (folded) |
| Include reasoning | toggle | off — thinking is long and rarely worth keeping |

Attachments honour the vault's own setting: read `.obsidian/app.json` → `attachmentFolderPath`
(`./attachments` relative, or an absolute vault path); if unset, use `<Folder>/attachments/`.

The plugin exposes **no LLM tools** (`tools: {}` is allowed by the loader; `registerPlugin` just
registers none). It exists for the card, the config and the lifecycle hook. If the loader
rejects an empty `tools` map, the fallback is one tool, `obsidian_export`, which the LLM can also
be asked to call ("save this conversation to Obsidian") — a nice extra anyway.

## What a conversation becomes

One note per conversation: `<Folder>/<session-colour>/<slug>-<id8>.md` (Decision 1: colour
subfolders, so the vault's file explorer mirrors the sidebar filter). `slug` = title sanitised (`[^a-z0-9]+` → `-`, max 60 chars);
`id8` = first 8 chars of the conversation id, so renames and duplicate titles never collide and
Obsidian's links to the note survive a title change.

### Frontmatter → Obsidian properties

```yaml
---
title: "Tasks: fetch sites, select top news worthy attention"
lumispec_id: f49d242b-e702-456e-b9f6-9d0a06ad7367
created: 2026-10-25T12:40:11Z
updated: 2026-10-25T13:05:52Z
session: amber
pinned: true
model: Qwen3.8-27B            # from /props model_alias when llama; claude model otherwise
messages: 2
tokens: 41230                 # tokenCount (measured context after the last turn)
tools_used: [web_search, web_fetch, run_python]
tags: [lumispec, lumispec/amber]
---
```

Dataview and the properties panel both read this. `tags` gets the session colour so the whole
sidebar filter is one tag search.

### Body

Stored shape (`src/services/conversations.js`): `messages[] = { role, content, sentAt }` where
user `content` is a string (or `{ text, images }`) and assistant `content` is
`{ text, reasoning?, toolUses?: [{ name, result }], taskRun?: [...] }` (`_diff`/`_images` are
already stripped before storage). Rendering rules:

- **User message** → `## 🧑 <local time from sentAt>` then the text. Hidden session-init prompts
  (the auto-submitted session prompt) are skipped, as in the UI.
- **Assistant message** → `## 🤖 <time>` then `text` verbatim — it is already Markdown. Applet
  blocks (`<applet type=…>…</applet>`) are cut out and written as sidecar files
  `attachments/<slug>-<id8>-applet-<n>.html`, replaced in the note by
  `> [!example]- Applet (<type>) — [[<file>]]`. Obsidian cannot render them; the link opens the
  file externally. Chart.js charts are therefore not visible in Obsidian (no server-side
  rasteriser) — accepted for v1.
- **Reasoning** (when enabled) → `> [!note]- Thinking` folded callout containing the trace.
- **Tool calls** → one folded callout per call: `> [!info]- 🔧 web_search — "AMD news latest"`,
  body = the result trimmed to 1,500 chars with `… (truncated, N chars)`; `_markdown` results
  are used when present since they are already tables. Results that were auto-saved to files
  (`_autoSaved`) link the file instead of inlining it.
- **Task pipeline runs** (`taskRun`) → `## 🎯 Pipeline` then `### Step n — <task text>`, nested
  `#### Subtask` for groups, each with its own tool callouts and the step output.
- **Images** the user attached → copied to attachments, embedded `![[file]]`.
- **Files saved by tools** (CSV etc. under `SOURCE_DIR`, referenced as `/files/<name>` in the
  text) → copied to attachments, links rewritten to `[[<name>]]`.
- Footer: `---` then `Exported from Lumispec · <updated> · [open](http://localhost:3000/#<id>)`
  (the app has no deep-link route today — **small frontend addition**, or drop the link).

### Compact summaries

The Compact feature replaces a pinned conversation's messages with a structured summary. When
that happens the note is regenerated like any other change, so the summary becomes the note —
which is usually the version worth keeping. Optional later: keep the pre-compact transcript as a
second file `…-transcript.md` linked from the summary note (`[[…]]`), so compacting never loses
the detail in Obsidian even though it does in Lumispec.

### Links between notes

- `lumispec/<colour>` tags group by session.
- A compacted note links its transcript (above).
- Later: the `wiki/` entries produced by `wiki_index` are Markdown already; exporting them into
  `<Folder>/wiki/` and rewriting `source: file:<path>` into `[[…]]` links turns the vault into
  the place where docs and the conversations that used them meet. Out of scope for v1 but the
  path layout should leave room: `<Folder>/wiki/` reserved.

## Triggers

- **Pin** → export; every subsequent change to a pinned conversation (new message, title edit,
  compact, token count) → regenerate. Hook: `savePinned()` in `services/conversations.js` is the
  single choke point for "pinned conversation changed" — call the exporter from there
  (debounced ~1 s, since a tool-heavy turn saves many times).
- **Unpin** → leave the note in place (Decision 2); write `pinned: false` in frontmatter on the
  next explicit export only.
- **Save to Obsidian** button in the sidebar row (next to pin/compact) → export this conversation
  now, pinned or not. `POST /api/conversations/:id/obsidian`.
- **Delete conversation** → leave the note (same reasoning as unpin). Optional "also delete note"
  confirmation later.
- Export is **idempotent**: same conversation → same path → file overwritten atomically
  (write `.tmp`, rename), so Obsidian never reads a half-written note.

## Implementation

- `src/services/obsidian.js` — `findVaults()` (read the registries), `resolveVault(cfg)`,
  `exportConversation(conv, cfg)` → `{ path, attachments }`, pure rendering function
  `renderNote(conv, opts)` → string (unit-testable without a vault).
- `src/tools/plugin-obsidian.js` — card (`configUi` extended with a `select` descriptor for the
  vault and `text`/`boolean` fields — the panel renderer needs those two control types added,
  generic), `cardStatus`, `enableWarning` ("no vault found — set OBSIDIAN_VAULT"), optional
  `obsidian_export` tool.
- `src/services/conversations.js` — `savePinned()` calls a registered `onPinnedChange` hook
  (keeps the store free of an Obsidian import).
- `src/routes/conversations.js` — `POST /:id/obsidian`.
- `src/public/js/app.js` — sidebar button + toast with the written path; card controls.
- `src/config.js` — `obsidian.vault` from `OBSIDIAN_VAULT`.
- Docs: `README.md` ("Add Obsidian export"), `HELP.md`, `CLAUDE.md` (plugin row, hook,
  `configUi` control types), release notes.

Safety: the exporter writes **only** under `<vault>/<Folder>/` and the vault's attachment folder;
paths are resolved and checked to start with the vault root (same guard as the source tools).
It never deletes files. `.obsidian/` is read, never written.

## Testing

- Unit: `renderNote()` against fixture conversations — plain chat, chat with tool calls and
  reasoning, pipeline run with subtasks, applet message, compacted conversation, hidden session
  prompt skipped; snapshot the Markdown.
- Registry parsing: fixtures for the three install locations, `open` precedence, missing file.
- Integration: export into a temp folder laid out like a vault (with `.obsidian/app.json`
  setting a custom attachment path), check paths, atomic write, idempotence (second export
  byte-identical), attachment copy.
- Live: pin a conversation, watch the note appear in Obsidian within a second; add a message,
  see it update; compact it, see the summary replace the transcript; open the properties panel.

## Rollout

1. `renderNote()` + unit fixtures; `findVaults()`; the plugin card with vault/folder/toggles and a
   working **Save to Obsidian** button. Manual export only. Useful on its own.
2. Auto-export on pinned change via the `savePinned` hook, debounced.
3. Applet sidecars, attachment copying, vault attachment-folder setting.
4. Transcript-preserving compact; `wiki/` export; deep link back into the app.

## Decisions (2026-10-25)

1. **Colour subfolders.** Notes live at `<Folder>/<session-colour>/<slug>-<id8>.md`, so the
   vault's file explorer mirrors the sidebar filter. The `lumispec/<colour>` tag is written too.
   Changing a conversation's colour moves its note; Obsidian updates links on move.
2. **Keep the note when a conversation is unpinned or deleted.** Unpin means "stop updating";
   the next explicit export writes `pinned: false`. The exporter never deletes from the vault.
   A later "also remove the note" checkbox on the delete confirmation is the only sanctioned way
   to remove one from the app.
3. **Reasoning export off by default**, with the toggle on the card. Flipping it on and
   re-exporting adds the trace retroactively, since every export regenerates the note from the
   stored conversation.

All decisions are made; the plan is ready to implement in the rollout order above.
