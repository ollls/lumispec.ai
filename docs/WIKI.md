# Wiki Plugin — Work In Progress

Handoff notes for the `plugin-wiki.js` work. Resume from here.

## The idea (Karpathy-inspired two-tier docs)

Build a **two-tier retrieval system** for project documentation:

```
wiki/           ← compressed overviews (cheap, always greppable)
  foo.md        ← YAML frontmatter + 1 paragraph + key topics + source: pointer
  bar.md
<original .md files>   ← full docs, loaded on demand
```

The wiki **is** the index. LLM greps `wiki/` → finds relevant overview → follows `source:` pointer → reads full MD only if the overview isn't enough. Hierarchical RAG without embeddings — retrieval by LLM reading summaries instead of vector similarity.

Origin: discussion of Karpathy's "cognitive core / memory as files" gist (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). User's framing: *"create wiki folder with compressed MD and then if you need original full blown MD to answer, llm will find it, so wiki is the index of top level overviews."*

## Why it fits ScrapChat

- `source_read` already provides `tree`/`grep`/`read` — the retrieval tools exist, no new ones needed on the read side.
- Compact button already proves the LLM-summarize pattern works.
- Wiki lives under `SOURCE_DIR`, auto-served at `/files/`, greppable via `source_read`.

## What was built

**File:** `src/tools/plugin-wiki.js` (new plugin, auto-loaded by `loadPlugins()` on restart — no other files touched)

**Group:** `wiki` — configurable (shows in Plugins panel), `condition: () => !!config.sourceDir`

**Tools:**

### `wiki_scan` (no params)
- Walks `SOURCE_DIR` using `git ls-files "*.md" "*.markdown"` (respects `.gitignore`), falls back to `find` with ignore dirs (`node_modules`, `.git`, `data`, `logs`, `dist`, `build`, `.next`, `venv`, `__pycache__`).
- Excludes `wiki/` itself.
- For each file returns: `path`, `size`, `compressed` (wiki entry exists), `stale` (source mtime > wiki mtime).
- Returns `nextBatch` of up to 20 uncompressed paths to feed the loop.

### `wiki_index({ path, force? })`
- Reads one source `.md`, calls `collectChatCompletion` with a strict system prompt (hardcoded inside `summarizeToWiki()`), writes result to `<SOURCE_DIR>/wiki/<same-relative-path>`.
- Skips if wiki entry already exists unless `force: true`.
- Path-escape protected on both source and wiki sides.
- Input cap: 24000 chars (truncates longer docs with `[... truncated ...]` marker).
- LLM call: `maxTokens: 1200`, `temperature: 0.2`, 90s timeout.
- Validates output starts with `---` (frontmatter); returns error with raw preview if not.
- Emits `tool_status` SSE event "Compressing <path>..." during LLM call.
- Returns `_markdown` field showing the compressed entry for frontend display.

**Output contract** (hardcoded in `summarizeToWiki` system prompt, plugin-wiki.js:56-83):

```markdown
---
source: docs/api.md
tags: [tag1, tag2, ...]       # 5-8, lowercase, hyphenated, specific
answers:
  - "question this doc answers"   # 3-6 natural-language questions
---
# {short title}

{One dense paragraph, 3-6 sentences — scope + key concrete facts/entities/APIs}

## Key topics
- topic one — one-line note    # 3-8 topics
- ...
```

Rules baked into the prompt: no large code blocks/tables (it's an index, not a copy), stub tag for trivial docs.

## Design decisions (intentional)

1. **One file per call.** User explicitly said "one by one." LLM loops externally via `wiki_scan.nextBatch`. Each compression is a visible tool round, retries are cheap, one bad file doesn't poison a batch.

2. **No new retrieval tools.** Read-side (grep wiki/ → read overview → follow `source:` pointer) uses existing `source_read`. No duplication.

3. **Git-aware file discovery.** `git ls-files` respects `.gitignore` automatically; falls back to `find` for non-git projects.

4. **Stale detection via mtime.** If source `.md` is newer than its wiki entry, `stale: true` in scan — lets you rebuild only drifted entries without full rebuild.

5. **No confirmation on writes.** Wiki writes scoped to dedicated `wiki/` subdir, non-destructive to originals. Could add `confirmFn` gated on `context.autorun` if desired.

6. **System prompt teaches the read pattern.** Plugin's `prompt` field injects instructions into the main system prompt when the group is active:
   - Retrieval: grep wiki/ first → read overview → only read full source if insufficient
   - Build: wiki_scan → wiki_index one at a time → report progress → skip already-compressed unless rebuilding
   - `routing` hints added to Tool Routing section

## Open question — left unresolved

**Where should the compression prompt live?** Currently hardcoded inside `summarizeToWiki()` at plugin-wiki.js:56-83. User asked about this in the last exchange before stopping.

Three options discussed:

1. **Saved prompt** in `data/prompts.json` under a fixed key (e.g. `__wiki_index__`), fetched via `getPromptByName()` at call time.
   - Pro: editable in UI
   - Con: coupling to prompts service, extra fetch

2. **External file** like `data/wiki-prompt.md`, read at call time.
   - Pro: simple, version-controllable
   - Con: another file to manage

3. **Exported constant** at top of plugin file (mirror `PRECISION_RULES`, `TASKMASTER_PROMPT` in `src/tools/index.js`).
   - Pro: matches existing project convention
   - Con: still requires code edit to change

**Recommendation given:** Option 3 for consistency with existing patterns. **User has not decided yet — this is where we stopped.**

## Known risks to watch in real use

- **Fenced-wrapping issue:** LLM sometimes wraps output in a ```` ```markdown ... ``` ```` fence even when told not to. If `wiki_index` returns "invalid summary (missing frontmatter)" errors, strip a leading/trailing fence before validating `startsWith('---')`.
- **24k char cap** may be too aggressive for big design docs — consider chunked summarization if many docs hit the truncation path.
- **Temperature 0.2** chosen for determinism; may want to lower to 0.1 if tag/answer quality drifts.

## How to test (when resuming)

1. Restart server — `loadPlugins()` auto-discovers `plugin-wiki.js`.
2. Open Plugins panel → "Wiki Index" should appear, enable it.
3. Prompt: *"Scan the project for markdown files and build the wiki, one file at a time."*
4. Verify `wiki/` folder is created under `SOURCE_DIR` with properly-formatted entries.
5. Test retrieval: *"What does CLAUDE.md say about the task pipeline?"* — LLM should grep `wiki/` first.

## Next steps when resuming

1. **Decide the prompt-location question** (option 1/2/3 above) — BUT see "Color-based compactors" below, which supersedes this.
2. **Bootstrap run** — actually execute `wiki_scan` + loop `wiki_index` over the ScrapChat repo's own markdown (`CLAUDE.md`, `README.md`, `HELP.md`, etc.) as the first real test.
3. **Fix fenced-output bug** if it appears during the bootstrap run.
4. Consider whether `wiki_index` should also be callable in batch mode (e.g. `paths: []` array) if the one-at-a-time round-tripping proves too slow.

---

## Follow-up discussion: color-based compactors (NEW — supersedes prompt-location question)

User's idea: reuse the existing **per-color custom compactors** (the ones the Compact button uses on conversations) for `wiki_index` too. Different colors would apply different compression styles to different kinds of docs.

### Why it fits

Infrastructure already exists:
- `src/services/compacts.js` — `getCompactByColor(color)` returns the user's custom compact prompt
- Compact button already passes `color` in body, uses that prompt
- Per-color compact prompt editing UI already works

Piggybacking means **zero new UI, zero new storage**.

### Tension to resolve

Compact prompts today are written for **conversations** (role-based turns, tool uses, outcomes). Wiki compression is for **static markdown docs**. Also `wiki_index` enforces a strict output contract (`---` frontmatter with `source:`/`tags:`/`answers:`) — a freeform compact prompt won't produce that, and without the `source:` pointer the two-tier retrieval pattern breaks.

### Three options considered

**Option A — Color as "style layer", format stays fixed** ⭐ RECOMMENDED
- Keep hardcoded frontmatter contract as system prompt
- Inject color compactor as **additional domain emphasis** between format rules and closing rules, under a `## Domain emphasis` heading
- Color prompts become "for blue/finance docs, lead with APIs and params"; "for amber/infra, lead with commands and config keys"; "for coral/meeting notes, lead with decisions and action items"
- Pro: format stability, existing compact prompts just need light augmentation
- Con: two sources of prompt, slight complexity

**Option B — Color fully replaces the prompt**
- Entire system prompt = `getCompactByColor(color)`, no format contract
- Pro: max flexibility, one prompt source
- Con: heterogeneous entries, no guaranteed `source:` pointer, breaks retrieval pattern
- Verdict: too loose

**Option C — Separate "wiki compactors" parallel to conversation compactors**
- New `src/services/wikiCompactors.js`, separate UI, colors as key
- Pro: clean separation, each tuned for its purpose
- Con: duplicates infrastructure, two sets of prompts to maintain

### Recommended implementation (Option A)

Concretely when resuming:
1. Add `color` parameter to `wiki_index` tool schema.
2. In `summarizeToWiki()`, fetch `getCompactByColor(color)` if `color` provided, inject its text as an extra paragraph in the system prompt between the format rules and the closing "Rules" section, under `## Domain emphasis`.
3. If no color passed → fall back to current generic behavior (no breakage).

This **supersedes the earlier "where should the prompt live" question** — the base format contract stays hardcoded in the plugin (Option 3 from earlier), and the user-editable part is the per-color compactor, which already has a home in the existing compacts service + UI.

### Follow-up ideas (not first cut)

- **Wiki path sharding by color**: `wiki/blue/docs/api.md`, `wiki/amber/infra/deploy.md`. Makes grep sharper ("grep wiki/blue/" = "search only finance overviews"). Alternative: skip sharding, rely on `tags:` frontmatter.
- **Auto-pick color from path**: config map like `{ 'docs/api/': 'blue', 'infra/': 'amber', 'notes/': 'coral' }` in `data/wiki-colors.json`. `wiki_scan` annotates each file with detected color, loop auto-passes right color per file. User configures mapping once.
- **Bonus UX**: if color auto-detection exists, `wiki_scan` output could group files by color so the LLM can report progress as "compressing 12 blue/finance docs, 8 amber/infra docs...".

### Decision status

**Not yet decided.** User asked to preserve the discussion but did not green-light implementation. When resuming, confirm the direction (Option A recommended) before wiring it up. Smallest first cut would be: color param + fetch + inject, skip sharding and auto-mapping until after first bootstrap run.

---

## Worked example: "same source, different lenses"

Concrete illustration of what Layer 2 (the color compactor sandwich filling) actually buys. One input markdown file, three color compactors, three different wiki entries — each optimized for a different grep.

### Input: `docs/payments.md` (hypothetical)

```markdown
# Payments Service

Handles charge/refund flow via Stripe. Owned by the platform team.
Deployed as `payments-svc` on k8s cluster `prod-us`. See runbook at ops/payments.md.

## API
POST /v1/charge — body: { amount_cents, currency, customer_id, idempotency_key }
  returns 201 { charge_id, status }
POST /v1/refund — body: { charge_id, amount_cents? (optional, full if omitted) }
Rate limit: 100 req/s per API key. Auth: Bearer token (service JWT).

## Deployment
Image: ghcr.io/acme/payments-svc. Deploy: `kubectl apply -f deploy/payments.yaml`
Env vars: STRIPE_KEY, DATABASE_URL, REDIS_URL. Canary rollout via Argo.
Rollback: `kubectl rollout undo deploy/payments-svc -n prod`.

## Design notes
2025-11 meeting: decided to move idempotency keys from Redis to Postgres for durability.
Owner: Sara. Tracked in JIRA PAY-1423. Deadline Q1 2026.
Known issue: double-charge race if client retries within 50ms — tracked PAY-1501.
```

### Layer 1 (always, hardcoded): format contract

The frontmatter shape (`source:` / `tags:` / `answers:`) + title + dense paragraph + key topics. **Never changes**, guarantees greppability and the `source:` pointer for fall-through reads.

### Layer 2: per-color domain emphasis

#### Blue compactor — "API/contracts focus"
> Lead with endpoint contracts: method, path, request shape, response shape, auth, rate limits. Treat deployment/ops details as secondary. Phrase `answers:` as integration questions a client developer would ask. Tags reflect API surface.

**Produces:**
```markdown
---
source: docs/payments.md
tags: [payments, stripe, rest-api, bearer-auth, idempotency, rate-limited]
answers:
  - "how do I charge a customer"
  - "what's the refund endpoint"
  - "what auth does payments use"
  - "what's the rate limit on payments"
  - "is charge idempotent"
---
# Payments Service API
Exposes POST /v1/charge (amount_cents, currency, customer_id, idempotency_key → 201 charge_id) and POST /v1/refund (charge_id, optional amount_cents). Bearer JWT auth, 100 req/s per key. Backed by Stripe.
## Key topics
- POST /v1/charge — idempotency key required, returns charge_id + status
- POST /v1/refund — amount optional (full refund if omitted)
- Auth — service JWT bearer token
- Rate limit — 100 req/s per API key
```

#### Amber compactor — "infra/ops focus"
> Lead with deployment surface: image names, manifests, env vars, rollout/rollback commands, cluster location, ownership. Treat API details as secondary. `answers:` should be operator questions. Tags include cluster, runtime, deploy tool.

**Produces:**
```markdown
---
source: docs/payments.md
tags: [payments-svc, kubernetes, prod-us, argo, stripe, platform-team]
answers:
  - "how do I deploy payments"
  - "how do I roll back payments"
  - "what env vars does payments need"
  - "which cluster runs payments"
  - "who owns the payments service"
---
# Payments Service Deployment
Runs as `payments-svc` on k8s cluster `prod-us`, owned by platform team. Image `ghcr.io/acme/payments-svc`, deployed via `kubectl apply -f deploy/payments.yaml`, canary rollouts through Argo. Requires STRIPE_KEY, DATABASE_URL, REDIS_URL.
## Key topics
- Deploy — `kubectl apply -f deploy/payments.yaml`
- Rollback — `kubectl rollout undo deploy/payments-svc -n prod`
- Env vars — STRIPE_KEY, DATABASE_URL, REDIS_URL
- Rollout — Argo canary
- Runbook — ops/payments.md
```

#### Coral compactor — "decisions/meeting-notes focus"
> Lead with decisions made, open issues, owners, deadlines, tracking IDs (JIRA/Linear). Treat API and deploy details as background. `answers:` should be project-status questions. Tags include owners, tracker IDs, quarter/deadline.

**Produces:**
```markdown
---
source: docs/payments.md
tags: [payments, decisions, sara, pay-1423, pay-1501, q1-2026, known-issues]
answers:
  - "what decisions were made about payments idempotency"
  - "who owns the payments idempotency migration"
  - "what's the double-charge bug status"
  - "what's the deadline for PAY-1423"
---
# Payments Service — Decisions & Open Issues
November 2025 meeting decided to migrate idempotency keys from Redis to Postgres for durability (PAY-1423, owner Sara, deadline Q1 2026). Known race condition causes double-charge on sub-50ms client retries (PAY-1501, open).
## Key topics
- Decision (2025-11) — idempotency keys moving Redis → Postgres
- PAY-1423 — idempotency migration, Sara, Q1 2026
- PAY-1501 — double-charge race on <50ms retry, open
- Owner — platform team / Sara
```

### Why this matters

Same source, three entries, three different greps:
- *"how do I charge a customer"* → hits blue (API surface)
- *"how do I roll back payments"* → hits amber (ops surface)
- *"who owns the idempotency work"* → hits coral (decisions surface)

None of those greps would reliably hit a single generic summary. The color compactor is what makes each entry a **purpose-built index** rather than a best-effort average.

### Two natural extensions this enables

1. **Multiple wiki entries per source file** — one per relevant color. `wiki/blue/docs/payments.md`, `wiki/amber/docs/payments.md`, `wiki/coral/docs/payments.md`. Same source, different lenses. The `source:` pointer still lets the LLM fall through to the full doc for anything the overview missed. This implies `wiki_index` should accept a color and shard output by it (or at least namespace by color in the filename).
2. **Targeted rebuilds** — "rebuild all amber entries after the deploy pipeline changed" without touching API or decision entries. `wiki_scan` could filter by color, loop only over that subset.

### Implication for the data model

If we go multi-lens, `wiki_scan`'s "compressed" flag needs to become per-color (a file can have a blue entry but no amber entry). Likely shape:

```js
{
  path: "docs/payments.md",
  size: 1234,
  entries: {
    blue:  { exists: true,  stale: false },
    amber: { exists: false, stale: false },
    coral: { exists: true,  stale: true  },
  }
}
```

And `wiki_index` takes `{ path, color, force? }` — one call = one color for one file. Loop externally, as before.

---

## Feedback loop gap (Karpathy's write-back) — where we stand

User's question: Karpathy's example has a feedback loop where answers from conversations flow back into indexed wiki knowledge. Where do we stand?

### Where we stand

**One-way pipeline, zero feedback loop.** The wiki plugin as designed is strictly:

```
existing .md files  ──compress──►  wiki/  ──grep──►  LLM reads at answer time
```

Nothing flows backward. Conversations happen, LLM reads wiki entries, produces answers, and **the answers vanish** — they live in the conversation record but don't become indexed knowledge. Next similar question re-derives from scratch.

### Three components we're missing

A real feedback loop needs all three, and we have none:

**1. Trigger — when does the loop fire?**

| Trigger | Pros | Cons |
|---|---|---|
| Manual button on assistant message | Safe, explicit, zero false positives | User discipline required; insights mostly never saved |
| On-compact | Piggybacks existing ceremony | Rare; compact is infrequent |
| On-pin | Pinning signals "this matters" | Same rarity |
| **LLM-initiated tool (`wiki_note`)** | Closest to Karpathy, scales with usage | Trust problem: LLM may save noise or skip gems |

**2. Extraction — what gets saved?**
Not prose. Structured facts: new entities/APIs, corrections, decisions, novel Q&A pairs (user's own question phrasing is gold — that's what future greps look like).

**3. Placement — where does it go?**
Three strategies:
- **A. Append-only notes** (`wiki/_notes/<slug>.md`): simple, no merge conflicts, reversible, but fragments knowledge.
- **B. Merge into existing entries**: single source of truth, but LLM merge is risky (can lose/invent info), needs conflict handling, loses git history.
- **C. Hybrid**: new insights → notes/; Q&A pairs → appended to `answers:` in existing entries.

### Do we need it?

**Not for v1, yes for the full Karpathy vision.**

The one-way pipeline is a complete, useful product on its own — it solves "too many docs, LLM can't find the right one." Ship it first, validate it helps, then add feedback loop.

Most "AI memory" systems in the wild are one-way too (RAG, vector DBs, etc.). Karpathy's write-back is the ambitious version, not the default.

But the feedback loop is where this stops being a search index and becomes a learning system. If the wiki is the only place insights accumulate, every conversation improves future ones.

### Smallest first step (when we add it)

One new tool:
```js
wiki_note({
  topic: "stripe webhook signature verification",
  content: "Stripe webhooks must be verified with the raw request body, NOT the parsed JSON. Use stripe.webhooks.constructEvent(rawBody, sig, secret).",
  tags: ["stripe", "webhooks", "security"],
  answers: ["why is my stripe webhook signature failing"],
  source_conv_id: "<current conversation id>"
})
```

- Writes to `wiki/_notes/<date>-<slug>.md` with frontmatter
- `source:` = `conv:<id>` (not a file path)
- LLM calls it voluntarily when it resolves something non-trivial
- System prompt: "*after resolving a non-trivial technical question, call `wiki_note` to preserve the finding*"
- `wiki_scan` shows these alongside file-derived entries
- Read path unchanged — grep picks them up identically

~60 lines, zero changes elsewhere. Intentionally skips: merge-into-existing, automatic extraction, conflict detection, UI button.

### Architectural gotchas to capture now

1. **Provenance shape.** `source:` becomes conv id, not path. Retrieval "fall through" reads need to know how to fetch a past conversation (`/api/conversations/:id`).
2. **Staleness inverts.** File entries go stale when source changes. Conversation entries can't go stale that way (conversations are immutable) but can become *wrong* when contradicted by newer convos. Different staleness model.
3. **Color ambiguity.** Conversations have a color. But if a blue/finance conversation discovers an amber/infra fact, which color does the note inherit? Detect or ask — messy.
4. **Trust calibration.** Feedback loops amplify good AND bad. LLM saves a wrong fact → reads it back next time as ground truth. Needs review queue, or timestamp decay, or source-weighted trust (tool output > pure reasoning).

---

## v1 forward-compat decisions (adjust BEFORE bootstrap run)

User directive: *"adjust our v1 cycle to make wiki_note easier to plan/code in the future."* Concrete v1 changes to absorb the feedback loop later without a refactor.

### 1. `source:` becomes a URI with a scheme

Change from bare relative path to scheme-prefixed URI:

```yaml
source: file:docs/payments.md   # v1
source: conv:abc123             # future wiki_note
source: conv:abc123#msg42-48    # future message-range note
source: web:https://...         # future web_fetch-derived
source: tool:etrade_account/... # future tool-result-derived
```

`wiki_scan` dispatches on the prefix. Unknown schemes pass through untouched. Tiny text change in the `summarizeToWiki()` system prompt template in plugin-wiki.js.

### 2. Reserve underscore-prefixed subdirs for non-file entries

File-derived entries mirror source paths: `docs/payments.md` → `wiki/docs/payments.md`.
Non-file entries get reserved top-level subdirs under `wiki/`:

- `wiki/_notes/` — wiki_note output (future)
- `wiki/_conv/` — conversation-derived entries (future)
- `wiki/_web/` — web-fetch-derived entries (future)

`wiki_scan` treats any `_`-prefixed top-level dir under `wiki/` as "do not try to match against source files — these are standalone." Underscore chosen to avoid colliding with real source paths.

### 3. `wiki_scan` walks wiki AND sources (unified view)

Currently source-rooted — walks source MDs, checks if matching wiki exists. **Change to unified scan:**

```js
{
  fileEntries: [ { source: "file:docs/payments.md", wikiPath, compressed, stale } ],
  noteEntries: [],   // empty in v1, populated when wiki_note exists
  orphans: [],       // wiki entries whose source file no longer exists
  nextBatch: [...]   // uncompressed file paths — kept for LLM build loop
}
```

In v1, `noteEntries` and `orphans` are always empty — zero runtime cost. But the shape is forward-compatible, and the LLM's system prompt instructions won't need rewriting when notes appear.

### 4. `last_updated:` in frontmatter, not mtime

Current plan: compare `wikiFile.mtime < sourceFile.mtime` for staleness. Breaks for conv-derived entries (no stable source mtime).

**Change:** `wiki_index` writes `last_updated: <source_mtime_iso>` into frontmatter at compress time. Staleness = parse frontmatter, dispatch on source scheme:
- `file:` → compare `last_updated` against current source mtime
- `conv:` → compare against last message timestamp (future)

Lives in one place (`isStale(entry)` dispatches on scheme). Cost in v1: regex-parse two frontmatter lines. No YAML library needed.

```yaml
---
source: file:docs/payments.md
last_updated: 2026-04-05T14:22:00Z
tags: [...]
answers: [...]
---
```

### 5. Tolerant frontmatter parsing

Don't strictly validate. Future entries will add `conv_id`, `confidence`, `superseded_by`, `created`, `color`. v1 code must ignore-through unknown fields. Mostly "don't write a rigid schema validator" — regex-based approach already does this, but make it an explicit rule.

### What NOT to do in v1 (resist scope creep)

- **Don't build `wiki_note`.** Prepare the ground only. Designing the feedback loop before seeing the read path work = guessing.
- **Don't add conversation-message resolvers** (`conv:abc#msg42`). Overkill.
- **Don't add orphan cleanup tool.** Scan detects, separate deletion tool waits.
- **Don't add confidence scores / decay / trust weighting.** Classic over-engineering before feedback data exists.
- **Don't reserve color + scheme + note sharding all at once.** Pick one. Recommendation: scheme-based subdirs (`_notes/`) now, defer color sharding until after bootstrap.

### Impact on plugin-wiki.js (edits to apply before bootstrap)

| Change | Location | Effort |
|---|---|---|
| `source: file:...` URI prefix | `summarizeToWiki()` system prompt | 1 line |
| `last_updated:` in frontmatter template | `summarizeToWiki()` system prompt | 1 line |
| `wiki_scan` unified shape (`fileEntries`/`noteEntries`/`orphans`) | `wiki_scan.execute()` | ~20 lines |
| Frontmatter parser helper for staleness | new small helper | ~15 lines |
| Reserved `_`-prefixed subdir skipping | `wiki_scan` walk logic + `prompt` field text | few lines |

**Total: ~40-60 lines added to v1.** Earns its keep the moment wiki_note exists.

### Decision status

User said: *"yes, but we probably need to adjust our v1 cycle to make wiki_note easier to plan/code in the future."* — interpreted as green light for the 5 forward-compat changes above. **Apply these edits to plugin-wiki.js before the bootstrap run.** Not yet applied — resume here.

---

## Naming decision: `wiki_index` (not `wiki_compress`)

**Decision:** Rename the tool from `wiki_compress` to `wiki_index`. User approved.

### Why `wiki_compress` was wrong

"Compress" evokes gzip / lossless byte-level compression — wrong mental model. The tool doesn't shrink bytes for storage efficiency; it produces a searchable index overview with a pointer back to the full source.

### Why `wiki_index` is right

1. **Matches the language used throughout the design discussion.** Wiki has been consistently framed as "the index": *"the wiki IS the index"*, *"two-tier index"*, *"index of top-level overviews"*, *"purpose-built index rather than best-effort average."* The tool that populates it should be named accordingly.
2. **Verb/noun pair with `wiki_scan`.** Scan surveys, index writes. Both short, imperative, jargon-free.
3. **Future-proof for wiki_note.** "Indexing" is a natural umbrella for both file-derived and conversation-derived entries.

### Alternatives considered and rejected

| Name | Verdict |
|---|---|
| `wiki_compress` | Misleading — implies byte-level compression |
| `wiki_compact` | Collides with ScrapChat's existing Compact button (conversation compaction) — confusing semantics |
| `wiki_summarize` | Too generic; doesn't convey "writes to index" |
| `wiki_digest` | Unusual vocabulary |
| `wiki_entry` | Noun-as-verb is awkward |
| `wiki_add` | Too generic; hides the LLM summarization step |
| `wiki_write` | Sounds mechanical |
| `wiki_ingest` | RAG jargon |
| `wiki_learn` | Too anthropomorphic |
| **`wiki_index`** | ⭐ Selected |

### Aside: the rename opens a future design option

With `wiki_index` as the name, there's a plausible future where `wiki_note` doesn't exist as a separate tool. Instead, `wiki_index` accepts any source URI and dispatches on the scheme:

```js
wiki_index({ source: "file:docs/payments.md" })            // v1 — compress a file
wiki_index({ source: "conv:abc123", content, tags, answers }) // future — note from conv
wiki_index({ source: "web:https://..." })                  // future — index a fetched URL
```

Single tool, single mental model, uses the same `source:` URI scheme already adopted for v1 forward-compat. LLM learns one tool instead of two.

**Not a decision for now** — flagged because the rename makes it a clean option later. Two separate tools (`wiki_index` + `wiki_note`) is also fine; they'd share the same output format and wiki folder.

### Impact of renaming

Tiny. Rename the tool key in `plugin-wiki.js`, update the `prompt` field text, update the build-pattern instructions. No routes, no services, no UI changes — the plugin is self-contained and nothing external references the tool name yet (bootstrap hasn't run). All references to `wiki_compress` elsewhere in this `WIKI.md` have been updated to `wiki_index` in the same edit pass.

---

## Two-stage architecture — color is deferred and optional

**Decision (user directive):** *"we build index and apply colored compress (filter) - two stages. colored compress - btw is very option at least for now."*

**This supersedes** the earlier Option A sandwich design and the color-baked-into-`wiki_index` approach. Color is fully removed from v1, deferred to a separate optional v2 tool.

### Stage 1 — `wiki_index` (v1, mandatory)

- Reads source `.md`, produces one canonical entry using the hardcoded format contract
- **Color-agnostic**, generic summarization
- One entry per source file
- Output: `wiki/<same-relative-path>.md`
- This is the *entire* v1 scope

### Stage 2 — `wiki_lens` (v2, optional — name TBD, could also be `wiki_filter`)

- Takes an existing wiki entry + a color → produces a re-framed version through that color's emphasis
- Only runs on explicit request, never implicit
- Output: `wiki/_lens/<color>/<same-relative-path>.md` (reserved `_`-prefixed subdir, same convention as `_notes/`)
- **Does not exist in v1.** Design sketch only — build when the base index has proven useful.

### Why this split is better than color-baked-in

1. **v1 scope shrinks** — all color logic disappears from the first cut. No `getCompactByColor` fetching, no sandwich prompt construction, no color parameter on the main tool.
2. **Base index is reusable** — blue and amber lenses both start from the same canonical entry; no duplicated summarization.
3. **Cheap prompt experimentation** — iterating on a color compactor re-runs `wiki_lens` only, doesn't re-read the full source.
4. **Truly optional** — ship v1, run bootstrap, see if the base index helps, then decide whether colors are worth the complexity.
5. **Opt-in means opt-in** — user has to explicitly ask "apply blue lens to payments.md"; no accidental color inheritance from session context.

### Open sub-question for Stage 2 (v2 decision, not v1)

When `wiki_lens` runs, does it read:
- **(a)** only the base wiki entry — cheap, fast, but can only re-frame what the base captured
- **(b)** the base entry + the full source MD — richer, slower, can surface details the base deprioritized

Lean toward **(b)** — base entry is a scaffold, not a source. If a generic base dropped a rate-limit detail, blue-lens (API focus) should be able to recover it, which requires reading the source. But start with (a) if simplicity matters more.

### What gets removed from v1

- Color parameter on `wiki_index`
- Path sharding by color (`wiki/blue/...`)
- `getCompactByColor` import / injection in plugin-wiki.js
- Sandwich prompt construction (Option A's Layer 2 domain-emphasis injection)
- Any references to colors in the plugin's `prompt` field or `routing` hints

### What stays in v1 (forward-compat still applies)

All five forward-compat changes from the earlier section still apply — none of them assumed color was in `wiki_index`. In fact, they're *more* consistent with the two-stage split:

- `source: file:...` URI scheme
- Reserved `_`-prefixed subdirs (`_notes/` for feedback loop, **add `_lens/` now as a reserved name** even though unused in v1)
- `wiki_scan` unified shape (walks `_lens/` entries too, reported as `lensEntries: []` — empty in v1)
- `last_updated:` frontmatter staleness
- Tolerant frontmatter parsing

### Status of earlier color sections in this doc

The earlier sections on color compactors (Option A, the payments.md worked example with blue/amber/coral outputs, the sandwich diagram) are **still valid as the design sketch for Stage 2** — they describe *how* `wiki_lens` would work when built. Re-interpret them as "v2 architecture, not v1 architecture." The worked example is the clearest artifact of what a color lens produces — keep it for reference when Stage 2 starts.

### Decision status

**User approved the two-stage split.** v1 = `wiki_index` only, no colors. Stage 2 (`wiki_lens`) deferred until after bootstrap validates the base index is useful. Not yet applied to plugin-wiki.js — the color code was discussed but never actually written into the plugin file (it's still the original simple version). Resume by:

1. Applying the 5 forward-compat changes (URI scheme, `_`-prefixed subdirs incl. `_lens/` reservation, unified scan, `last_updated:`, tolerant parser)
2. Renaming `wiki_compress` → `wiki_index` in the plugin
3. Running the bootstrap on the project's 10ish markdown files
4. **Only then** deciding whether to build Stage 2

---

## What `wiki_lens` is actually FOR (semantic purpose)

Key question from user: *"let us say we already have wiki_lens - so the purpose of wiki_lens is to accentuate attention to certain facts and disregard others, or just compress by dropping more things... that kind of activity"*

**Strong opinion: lens is about selective emphasis and relevance ranking, NOT further compression.** Size reduction is a trap.

### The trap: "lens as aggressive compressor"

If the lens's job is "drop more things," you hit immediate problems:
1. **Base index is already compressed.** v1's whole point is that the base entry is small. Making it smaller doesn't unlock a new capability — it loses information.
2. **Smaller = more false negatives.** Shorter entries have fewer keywords. A blue-lens that drops 40% of content is 40% more likely to miss a grep that would have hit the base.
3. **If you want tighter, just tighten the base.** "Even smaller" isn't a lens concern — it's a prompt-engineering concern for `wiki_index` itself.

Lens size is a **side effect**, not a goal. It might happen to be smaller (if it drops irrelevant topics), the same size (if it just reorders), or slightly larger (if it surfaces details the base deprioritized).

### The right framing: **lens = retrieval optimization for a specific query vocabulary**

A lens exists to maximize the chance that a query *from a specific domain* hits the right wiki entry. Four concrete jobs:

**1. Promote domain-relevant facts to high-signal positions.**
Grep/embedding retrieval is position-biased — facts in title, first paragraph, tags, and `answers:` are weighted more than facts buried in key-topics. Blue moves API contracts to the front; amber moves deploy commands to the front. Same facts may exist — reordered by priority.

**2. Align vocabulary to the domain's phrasing.**
Base uses neutral language. A blue/finance user searches for "endpoint," "payload," "rate limit." An amber/infra user searches for "kubectl," "manifest," "rollback command." Even the **same concept** gets different lexical treatment:

| Concept | Base phrasing | Blue-lens phrasing | Amber-lens phrasing |
|---|---|---|---|
| Auth | "authenticated requests" | "Bearer JWT, service token" | "STRIPE_KEY env var" |
| Reliability | "error handling" | "retry with idempotency_key" | "Argo rollback, canary health" |

**Highest-value job of a lens** because it directly improves retrieval without risking information loss.

**3. Drop facts the domain genuinely doesn't care about.**
Not "drop to make it smaller" — **drop to reduce noise-hits from unrelated domains.** If a payments doc has a paragraph about meeting notes (PAY-1423, owner Sara), and you grep blue for "Sara," you *shouldn't* hit payments — a finance/API user searching "Sara" isn't looking for the payments service. Dropping meeting notes from blue makes blue more **precise** for blue queries. Criterion is **relevance**, not **size**.

**4. Recover facts the base deprioritized.**
Inverse of #3. Base is best-effort average across all domains, so it drops details that aren't universally important. A rate-limit caveat that's footnote-level for base is front-page material for blue. Lens can re-read the full source (option (b) from earlier sub-question) and promote buried specifics. **Strongest argument for option (b)** — the lens isn't just re-shuffling the base, it's a second pass at the source with a specific priority filter.

### Litmus test for lens quality

When reading a lens output, ask: *"If I grepped this with queries from this domain, would I hit it more reliably than the base?"*

- **Good lens** — yes. First paragraph, tags, and answers use the domain's vocabulary and promote domain facts. Retrieval precision goes up.
- **Bad lens (aggressive compression)** — shorter than base but same vocabulary. Lost information without improving retrieval.
- **Bad lens (just reordering)** — same content and vocabulary as base in slightly different order. No real retrieval benefit.
- **Bad lens (imaginary facts)** — has "facts" the source doesn't support. LLM hallucinated to fit the color's emphasis. **Dangerous** — breaks trust in the wiki.

### One-line definition

> **A color lens is a targeted retrieval index for a specific domain's query vocabulary. It optimizes for grep precision from that domain, using selective emphasis, vocabulary alignment, noise reduction, and targeted recovery — not byte-level compression.**

### Draft prompt for Stage 2 (when built)

The color compactor prompt should explicitly instruct the LLM in retrieval-optimization terms, not "summarize this for X audience" terms:

> You are producing a retrieval-optimized lens for a neutral wiki entry. Your job is to maximize the chance that a query from the {color} domain hits this entry.
>
> 1. **Vocabulary alignment** — phrase all content in the terms a {color} user would search with.
> 2. **Priority promotion** — move {color}-relevant facts to the title, first paragraph, and `answers:` field.
> 3. **Noise reduction** — drop facts that are irrelevant to {color}, to avoid false-positive grep hits from unrelated domains.
> 4. **Targeted recovery** — if the full source contains {color}-relevant details the base entry deprioritized, surface them.
>
> Do NOT just shorten the base. Do NOT invent facts not supported by the source. Keep the same frontmatter structure (`source:`, `tags:`, `answers:`) but rewrite all string content through the {color} lens.

### Why this framing is measurable

"Maximize grep hit rate from this domain" is a **testable property**. Take 10 domain queries, grep `wiki/_lens/blue/` vs `wiki/`, compare precision/recall. The aggressive-compression framing isn't measurable (shorter is just shorter). When Stage 2 arrives, this gives us a way to judge whether the lens prompt is working — run the same query set before and after a prompt change and see if hit rate improves.

---

## Lens composer (Stage 3 — speculative, far future)

User observation: *"ah I guess we end up with some sort of lens composer in the future"* — almost certainly correct. Captured here so the conceptual frame doesn't get lost.

### Why composition matters

Real queries are rarely one-dimensional. *"Why did we decide to rewrite the payments webhook verification?"* simultaneously hits:
- Decision context (coral lens)
- API/security details (blue lens)

A single-color lens forces picking one angle. A composed `blue + coral` would serve the query better.

### Composition model (principled, not vibes)

Because lenses are defined as **retrieval-optimization specs with four jobs** (promote / align / drop / recover), each job has a natural composition rule:

| Job | Composition rule |
|---|---|
| **Promote** | Union — promote facts *either* lens would promote |
| **Vocabulary align** | Union — use terms from *both* domains |
| **Drop** | **Intersection** — only drop facts *both* lenses would drop (genuinely noise to both) |
| **Recover** | Union — surface buried facts *either* lens would want |

**Key insight: drop-by-intersection.** Composition should never make output narrower than either individual lens. `blue + coral` is strictly richer than blue alone or coral alone. Composition adds, never subtracts.

Formal: `compose(L1, L2) ⊇ L1 ∪ L2` in retrieval terms. Precision *might* drop slightly (hitting more queries), but recall strictly increases. For cross-domain queries, that's the right trade.

### What a composer could look like (product shapes, in order of ambition)

1. **Lens library** — author/edit lens definitions alongside Prompts/Sessions/Templates menus. Structured (not freeform prompts): tag vocabulary, promote patterns, drop patterns.
2. **Lens playground** — paste source MD, pick/compose a lens, see output live. Iterate on the prompt, watch output shift.
3. **Query evaluator** — paste query set, grep wiki with each lens (and compositions), show hit-rate tables. Makes "better lens" measurable, not vibes-based.
4. **Auto-compose** — LLM sees a query, picks/composes a lens on the fly. No pre-authored colors at all — composer generates one-shot lens spec per query. Most Karpathy-like; hardest to get right.
5. **Lens inheritance** — base "engineering" lens that blue/amber inherit and specialize. Avoids duplication across similar lenses.

### The load-bearing conceptual frame to preserve

> **Lenses are composable retrieval specs, not hand-crafted summaries.**

If this frame is kept, the composer falls out naturally when needed. If it drifts into "lenses are styles of prose" or "lenses are summary templates," composition becomes incoherent and the whole thing has to be re-thought.

### Status

Speculative Stage 3. Not to be built before Stage 2 (`wiki_lens`) has proven useful. Not even Stage 2 is approved yet — this is here purely so the composition insight isn't lost if we start building lenses and the composer question comes up later.

---

## Implementation status snapshot

| Stage | What | Status |
|---|---|---|
| **Stage 1** | `wiki_scan` + `wiki_index` (color-agnostic base index) | **Built and verified.** Lives in `src/tools/plugin-wiki.js`. All five forward-compat decisions applied: `file:` URI scheme, `_`-prefixed reserved subdirs (`_notes`, `_lens`, `_conv`, `_web`), unified `wiki_scan` shape (`fileEntries` / `noteEntries` / `lensEntries` / `orphans` / `nextBatch` / `hasMore`), `last_updated:` frontmatter staleness, tolerant frontmatter parser. |
| **Plugin auto-dependency system** | Cascade-enable + block-disable across plugin groups | **Built and verified.** Lives in `src/tools/index.js`. The wiki plugin declares `dependencies: ['source']` — enabling wiki cascade-enables source; disabling source while wiki is enabled is blocked with a clear UI toast. See `AUTO_DEPENDECY_FOR_PLUGINS.md` for the full design + implementation notes. |
| **Stage 2** | `wiki_lens` — color-lens reframing | Not built. Design captured above as "Two-stage architecture" + "What `wiki_lens` is actually FOR" + the worked payments.md example. |
| **Stage 3** | Lens composer | Not built. Speculative design above. |
| **`wiki_note` (feedback loop)** | Conversation-derived knowledge into `wiki/_notes/` | Not built. Design captured above under "Feedback loop gap". `_notes/` subdir is reserved at the data-model level so the future tool drops in cleanly. |

When Stage 2 is built, it will use the existing `wiki/_lens/<color>/` reserved subdir convention from Stage 1 — no schema changes needed. Same for `wiki_note` and `wiki/_notes/`.
