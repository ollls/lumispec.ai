# Knowledge Hardening — Cite Mode

**Status: implemented as Cite mode on the `dev` branch.** The toggle is wired through the system prompt, the wiki indexer, the source plugin's diff highlighter, and the frontend. Default state is ON (`localStorage.getItem('citeEnabled') !== 'false'`). The discussion below is preserved as the design rationale; the "Locked-in design" and "Implementation surface area" tables now describe shipped behavior, not a proposal.

**Pairs with** [`WIKI_KNOWLEDGE.md`](WIKI_KNOWLEDGE.md), which defines the trust philosophy Cite mode enforces.

**Motivation:** the v1.0 docs went through a hallucination incident where an LLM-authored `docs/TASKMASTER.md` invented an entire architecture that did not exist in the codebase (including a fictional `src/taskmaster.ts` in a JavaScript-only repo). The bad source doc was then faithfully compressed by `wiki_index` into a confident wiki entry, which propagated into release notes and into other docs. The corrections landed across commits `a3c5baa`, `9b66874`, `f0d82e2`, `09a96b6`, `9458a84`. This document asked: **how do we prevent the next one mechanically, instead of relying on a human reviewer to catch it?** Cite mode is the answer.

---

## Cite mode — what shipped

Cite mode is a per-conversation toggle (label: **Cite**) in the input area, persisted to `localStorage` as `citeEnabled` with default `true`. When ON, three coordinated mechanisms run:

### 1. System prompt rule

`CITE_RULES` (a constant in `src/tools/index.js`, injected by `getSystemPrompt({ ..., cite })`) tells the LLM that code-citation discipline is active. The rules cover:

- Markdown documentation writes — every architectural claim must be backed by a `(file:line)` citation
- Read-before-drafting workflow
- Code claims in chat answers are subject to the same rule
- No training-data inference about this codebase
- Refuse-to-fabricate policy: read first, write second

### 2. Diff-preview claim highlighter (soft signal)

When `source_write` or `source_edit` writes a `.md` file under cite mode, two checks run:

- **Pattern-based** — `extractAddedLines(diff)` + `detectUncitedClaims(addedLines)` (in `src/tools/index.js`). Three narrow regex patterns: file paths followed by behavioral verbs, backtick-quoted identifiers followed by implementation verbs, and numerical claims with units. Lines that already contain a `(file:line)` or `` `file:line` `` citation are skipped.
- **Reference-based** — `validateCitations(text, sourceRoot)` walks any citations the LLM produced and verifies each path exists on disk and the line number is within the file. Broken citations are reported alongside pattern matches.

The combined warnings are attached to the tool result as `_citeWarnings: [{ line, snippet, reason }, ...]`. The frontend renders them as a small amber-tinted block above the diff preview (`renderCiteWarnings()` in `src/public/js/app.js`). The write is **never blocked** — the warnings are informational, the human approver decides.

The `_citeWarnings` field is stripped from the LLM context (it's a UI-only affordance) the same way `_diff`, `_images`, and `_rateMap` are stripped.

### 3. `wiki_index` strict mode (hard signal)

When `wiki_index` runs with `cite: true` in its tool context, two things change:

- **Stricter indexing prompt** — `indexToWiki()` in `plugin-wiki.js` appends a `CITE_INDEX_RULES` block to the base summarization prompt. Numbers must appear in the source verbatim, no training-data inference, vague source = vague summary, no inventing key topics, return a stub for empty docs (do not pad). Temperature drops from `0.2` to `0.1`.
- **Path validator** — after the LLM produces the summary, `validateCitations()` runs on it. Any broken citation (file doesn't exist, or line number outside the file) causes the wiki entry write to be **refused**. The error response lists the broken citations so the user can fix the source doc and retry.

When the validator passes, the entry is stamped with `cite_mode: true` in its frontmatter as provenance.

### Locked-in design

| Lever | Where (`file:LINE`) | Behavior |
|---|---|---|
| Toggle UI | `src/views/index.html:317-322` | `Cite` checkbox in input area, default checked |
| Toggle state | `src/public/js/app.js:19` | `state.citeEnabled`, localStorage `citeEnabled`, default `true` unless explicitly set to `'false'` |
| POST wiring (chat) | `src/public/js/app.js:1071` | sent as `cite: true|false` in `/messages` body |
| POST wiring (pipeline) | `src/public/js/app.js:1410` | sent as `cite: true|false` in `/tasks` body |
| Backend prompt assembly | `src/tools/index.js` `getSystemPrompt({ cite })` | injects `CITE_RULES` when `cite === true` |
| Backend chat route | `src/routes/conversations.js:124` | reads `cite`, passes to `getSystemPrompt` and tool context |
| Backend pipeline route | `src/routes/taskProcessor.js:54` | reads `cite`, threads through `processOneStep` and `buildToolContext` |
| Diff highlighter | `src/tools/plugin-source.js` `runCiteCheck()` | called from `source_write` and `source_edit` execute paths when `context.cite === true` and target is `.md` |
| Wiki strict prompt | `src/tools/plugin-wiki.js` `CITE_INDEX_RULES`, `indexToWiki({ cite })` | stricter system prompt + lower temperature when `cite === true` |
| Wiki path validator | `src/tools/plugin-wiki.js` `wiki_index.execute` | refuses write if `validateCitations()` finds broken paths |
| LLM-context strip | `src/routes/conversations.js`, `src/routes/taskProcessor.js` `buildToolResultText()` | `_citeWarnings` stripped from tool result before sending to LLM |
| Frontend warning render | `src/public/js/app.js` `renderCiteWarnings()` | amber-tinted block above the diff preview |

### Refuse-write vs soft-warning asymmetry

Cite mode preserves the asymmetry from the original design discussion:

- **`wiki_index` path validator → refuse-write.** A broken `(file:line)` citation is unambiguous: the path either resolves or doesn't. There's no edge case. A failed validator is concrete evidence of fabrication, and refusing the write keeps the fabrication out of version control. Loud failure here is a feature.
- **Diff highlighter at write time → soft warning.** A "claim-shaped sentence without nearby citation" is heuristic. There are legitimate edge cases (release notes describing planned features, history docs about past states, prose about behavior the LLM verbally reasoned through). A hard block would create friction for legitimate work. Soft warning preserves human judgment.

Deterministic checks get hard enforcement; heuristic checks get soft signaling.

### What this catches and what it doesn't

**Catches automatically:**
- Citations to nonexistent files (the `src/taskmaster.ts` failure mode) — wiki_index refuses, diff highlighter flags
- Citations to real files at out-of-range line numbers
- Numerical claims in docs without nearby citations (the "constant ~500 tokens per task" failure mode) — diff highlighter flags
- Claim-shaped paragraphs about file paths or identifiers with no citation at all — diff highlighter flags

**Does not catch:**
- Subtle claims that don't match the regex patterns
- Citations to real files at real lines that *also* don't actually contain what the doc says they contain (citation looks valid, content of cited line is unrelated)
- Hallucinations in non-`.md` files (Cite mode is doc-focused)
- Hallucinations the LLM produces in chat answers but never writes to a file

The system is defense in depth, not a perfect filter. The four layers (system prompt rule, diff highlighter, wiki path validator, human-in-the-loop on diff approval) cover different failure modes. Each is cheap individually and they compound.

---

## Original design discussion (preserved for context)

---

## What actually went wrong

The TaskMaster incident wasn't a single failure. It was a chain of three:

1. **Source-doc creation.** Some agent wrote `docs/TASKMASTER.md` with invented content. It pattern-matched "TaskMaster + context isolation + low-memory local LLM" against generic LLM-orchestration literature in its training data and confabulated a system that would *plausibly* live in this codebase. It even invented `src/taskmaster.ts` — a TypeScript file in a JavaScript project. That should have been impossible to write if the agent had grep'd the repo first.
2. **Indexing.** `wiki_index` faithfully compressed the false claims into `wiki/docs/TASKMASTER.md`. It had no signal that the source was wrong, and its system prompt rewards confident dense paraphrase ("3-6 sentence dense paragraph, no fluff"). Confident dense paraphrase of fiction is fiction with extra confidence.
3. **Propagation.** The wiki entry got grep'd by future agents, who quoted "TaskMaster context isolation" as established knowledge, which fed back into `releases/1.0.0.md` and `docs/WIKI_KNOWLEDGE.md` workflow examples. The false framing spread.

**The root cause is at layer 1.** Layers 2 and 3 only amplified what was already wrong. The indexer is the wrong place to make the *primary* fix — but it can be a useful tripwire. Multiple layers, each catching different failure modes, are stronger than any single layer.

---

## The intervention layers

| Layer | Where in code | Strength | Cost |
|---|---|---|---|
| Global system prompt rule | `src/tools/index.js` `getSystemPrompt()` | Soft (LLM may ignore) | Free |
| Source-plugin write hint | `src/tools/plugin-source.js` `prompt` field | Soft, scoped to source writes | Free |
| Read-before-write enforcement | `source_write` / `source_edit` execute paths | Hard (refuse) | Session state tracking |
| Diff-preview claim highlighter | `source_edit` diff generation + frontend renderer | Soft + visible to human | Regex pass, no LLM |
| `wiki_index` indexing prompt | `plugin-wiki.js` `indexToWiki()` system prompt | Soft, scoped to indexing | Free |
| `wiki_index` mechanical checks | `plugin-wiki.js` post-generation pass | Hard (refuse or flag) | Filesystem grep |
| `wiki_index` two-pass review | `plugin-wiki.js` second `collectChatCompletion` | Soft + reportable | One extra LLM call |
| Wiki schema (`kind:` field) | `plugin-wiki.js` frontmatter shape | Structural | Prompt complexity |
| `wiki_scan` evidence-quality flag | `plugin-wiki.js` scan output | Soft, retrieval-side | Frontmatter parse |
| Provenance fields in frontmatter | `plugin-wiki.js` write step | Soft, audit-trail | Trivial |

**The earlier in the chain, the more leverage. The later in the chain, the easier to verify mechanically.**

---

## Concrete proposals

### Proposal 1 — Global "code claims require code reads" rule

The main system prompt has an `## ABSOLUTE RULE: Never Fabricate Data` section, but it's scoped narrowly to **tool results** (web_search snippets, web_fetch failures, etc.). It does not cover **claims about the codebase itself**. There is no rule that says "before claiming a function, file path, parameter name, or behavior, you must have read the relevant file with `source_read`."

A new section, modeled on the existing absolute rule:

> ## ABSOLUTE RULE: Code claims require code reads
>
> Before stating that a file, function, class, env var, parameter, default value, or behavior exists in this codebase, you must have read the relevant source file in this conversation. Citing code from memory or inference is fabrication. If you have not read it, say "I haven't checked yet" and read it first.
>
> This applies in particular when writing or editing markdown documentation. Diagrams, architectural claims, and code-flow descriptions in `docs/`, `releases/`, or any `.md` file must be backed by `(file:line)` citations into files you have actually read in this session.

**Tradeoffs:**
- **Global vs scoped:** global is more aggressive — it would also constrain casual chat ("what does Express do?") which might be annoying. Source-plugin-scoped is more surgical but misses cross-cutting cases. A weaker version: only enforce when the LLM uses `source_write`/`source_edit` on a markdown file under `docs/` or `releases/`. That's the narrowest, lowest-friction guard, and it covers the exact failure mode that produced the TaskMaster doc.
- **Soft enforcement:** the LLM may still ignore it. System-prompt rules are not hard constraints. But the same scaffold has successfully enforced "never fabricate data" in `plugin-etrade.js` (the fabrication detector), so there's precedent that strong prompt-level rules with concrete examples do change behavior.

**Cost:** ~30 lines of prompt text, no code changes outside `src/tools/index.js`.

**Open decision:** global, source-plugin-scoped, or only on `.md` writes?

---

### Proposal 2 — Strengthen the `wiki_index` indexing prompt

The current `system` string in `indexToWiki()` (`plugin-wiki.js:148-175`) tells the LLM to produce dense, confident summaries. It does not tell the LLM that the source might be wrong, nor does it bound creative paraphrase. Several additions:

1. **"Do not invent details. If the source is vague, your summary must also be vague — do not crystallize ambiguity into specifics."** Directly addresses paraphrase-as-invention.
2. **"Numerical claims (constants, percentages, byte counts, line counts) must appear in the source verbatim. Do not paraphrase numbers."** Numbers are the easiest hallucinations to detect later and the most damaging — the original wiki entry confidently said "constant ~500 tokens per task," a number that didn't exist in any source doc.
3. **"Do not draw on general LLM/AI literature, training-data knowledge, or analogies to other projects. The only source of truth is the document I am providing. If the document does not mention X, X does not exist in this project."** Direct counter to the "TaskMaster pattern-matched generic orchestration literature" failure.
4. **"If the document refers to a file path, function name, or symbol that you would normally explain from training data, do NOT explain it. Just preserve the reference."**
5. **"Tags must use terminology present in the source. Do not invent project-specific jargon."**
6. **Drop the "still produce a valid entry" instruction for trivial docs.** The current prompt at `plugin-wiki.js:175` says: *"If the document is trivial (< 200 chars) or has no real content, still produce a valid entry but mark tags with 'stub'"*. That's the wrong instinct — it pressures the LLM to invent content for thin docs. Better: *"If the document has no real content, return a stub entry with empty key topics. Do not invent topics."*

**Cost:** zero code, zero compute. All changes live in the prompt string.

**Testable:** take the original `b6cdaa2` `docs/TASKMASTER.md`, run it through the corrected prompt, and check whether the summary still hallucinates as confidently. This is a perfect natural experiment — the failure case is preserved in git history.

**Open decision on temperature:** the indexer is currently `temperature: 0.2` (`plugin-wiki.js:187`). Going to `0.0` would reduce creative paraphrase further but might make summaries flatter. Worth experimenting with — but only after the prompt fixes, since temperature is a multiplier on whatever the prompt gives it.

---

### Proposal 3 — Mechanical checks in `wiki_index` (deterministic, not LLM)

Some checks are cheap, mechanical, and immune to LLM behavior. They should run after the LLM generates the summary:

#### 3a. Path-citation validation

Parse the generated summary for path-like strings (`src/...`, `docs/...`, `data/...`, `wiki/...`). For each, verify the file exists on disk under `SOURCE_DIR`. Any path that doesn't resolve is a fabrication.

> **This single check would have caught `src/taskmaster.ts` automatically.** ~20 lines of code, runs in microseconds, no LLM call.

#### 3b. Numerical-claim cross-check

Parse the summary for numbers + units (`32K chars`, `500 tokens`, `8 results`, `20 rounds`). For each, verify it appears in the source doc that the indexer was given. Numbers in the summary that aren't in the source → flag as suspicious.

> **This would have caught "constant ~500 tokens per task."**

#### 3c. Symbol grep (cheap version)

Parse the summary for backtick-quoted identifiers (`function_name`, `MAX_FOO`, `web_search`). Optionally grep them against the source tree. Identifiers not found anywhere → log warning. Not a hard fail, but surfaces in the tool result.

#### 3d. Refuse vs warn

For each mechanical check, the policy can be **strict refusal** (don't write the wiki entry; return an error listing the bad citations) or **soft warning** (write the entry but attach a `warnings:` field to the frontmatter). Strict is safer; warnings are more permissive and lossy.

**Open decision:** strict refusal or warnings, and at what threshold?

---

### Proposal 4 — Two-pass hostile review (the "manual audit, automated")

After generating the summary, run a *second* `collectChatCompletion` with a different system prompt:

> You are a skeptical reviewer. The source document is below, followed by a proposed summary. Find any claim in the summary that is not directly supported by the source. Output: a list of unsupported claims, or the literal string `OK`.

If the response isn't `OK`, either auto-regenerate the summary (one retry), refuse to write, or attach the warnings to frontmatter.

**Why this works:** it uses a different system prompt that breaks the indexer's frame. The reviewer is told to *find problems*, not *produce content*. Different objective, different failure mode. This is the closest mechanical analog to what a human reviewer (or "last line of defense" agent) would do, and it scales.

**Cost:** **2x the LLM calls per indexed file.** For a 5-file rebuild, trivial. For a 100-file rebuild, doubles the cost. Tradeoff: never mandatory, opt-in via a `verify: true` parameter, or only triggered when mechanical checks (Proposal 3) already flagged something.

**Open decision:** always-on, opt-in, or auto-triggered as a fallback for mechanical-check failures?

---

### Proposal 5 — Wiki schema with `kind:` field

The current wiki entries are free-form summaries with free-form tags. A controlled vocabulary would help differentiate which claims need verification and which don't:

```yaml
kind: architecture | api-reference | how-to | release-notes | history | concept
```

Different kinds get different indexing prompts:

- **architecture** entries require `(file:line)` citations and reject summaries with no code references
- **api-reference** entries must list real function/parameter names that grep matches
- **how-to** entries can be more prose-heavy but must reference real commands
- **release-notes** entries are explicitly retrospective and can describe shipped features without per-claim code citations (the release notes are the citation)
- **history** entries (like the rewritten `TOOL_MODULARIZATION.md`) are explicitly historical and not authoritative for current state
- **concept** entries are abstract/explanatory and not subject to code-citation rules

**Why this matters:** the same indexer prompt today is used for wildly different doc types. A how-to doesn't need the same skepticism as an architecture spec. The current system imposes a one-size-fits-all rule, which is either too strict (blocking how-to creation) or too loose (letting architecture docs hallucinate).

**Cost:** moderate. Requires schema in `plugin-wiki.js`, classification logic (or LLM-asked at index time), and per-kind prompt templates.

**Open decision:** is it worth the schema complexity, or should architecture docs just use a separate tool (`wiki_arch_index`) with stricter rules?

---

### Proposal 6 — Source-extracted skeleton

Instead of asking the LLM to invent the structure, **extract it from the source**:

- Pull H2/H3 headings as `key_topics`
- Pull the first sentence of each section as the brief
- Use the doc's existing frontmatter (if any) for `tags`
- Only ask the LLM for genuinely creative work like the `answers:` field

**Why this works:** it shrinks the LLM's surface area by ~70%. The LLM can't hallucinate a key topic if the key topics are extracted directly from the source's heading structure.

**Cost:** moderate. Requires a markdown parser inside `plugin-wiki.js` (or use `linkedom` which is already a dep). Might need fallback for docs with no clear heading structure.

**Tradeoff:** less narrative compression. Wiki entries become more skeletal and less readable. Pure win for hallucination resistance, partial loss for retrieval ergonomics.

**Open decision:** worth the readability tradeoff?

---

### Proposal 7 — Pointer-only entries (radical)

Even more radical: wiki entries don't *summarize* at all. They contain only:

- A list of grep'able key terms
- A pointer to the source doc
- Maybe the doc's existing frontmatter

Any specific claim has to come from the source on demand. This eliminates compression entirely — and with it, the entire surface area for compression-induced hallucination.

**Cost:** every retrieval becomes a 2-step (`grep wiki/` → `read source`) instead of a 1-step. More tokens spent at query time, fewer at index time.

**Open decision:** is this safer-but-slower model worth it for high-risk doc kinds, even if it's not the default?

---

### Proposal 8 — Provenance fields

Add to every wiki entry's frontmatter:

```yaml
indexed_by_model: qwen3-35b-a3b
indexer_version: 1
verifier: none | basic-checks | two-pass-hostile
warnings: [...]    # if any mechanical check flagged something
```

**Why this matters:** when the next agent grep's the wiki, they can see "this entry was generated by a smaller model with no verifier — treat with appropriate skepticism." Cheap, no behavior change at index time, but it makes provenance visible to future readers.

**Cost:** trivial — extend `enforceFrontmatterFields()` in `plugin-wiki.js`.

**Open decision:** does telling the LLM "this came from model X" help or create weird recursive distrust? My instinct is it helps — provenance is always useful for audits — but it's worth thinking through.

---

### Proposal 9 — `wiki_scan` evidence-quality flag (retrieval-side defense)

A different angle entirely. Instead of (or in addition to) preventing hallucinations from entering, make the *retrieval* layer aware of citation density. Add to each `wiki_scan` entry:

```js
{
  source: 'file:docs/FOO.md',
  cited: true,                  // doc contains at least N (file:line) citations
  citationDensity: 0.83,        // citations per claim, ratio
  ...
}
```

Then the LLM at query time can prefer high-citation entries over low-citation ones, and flag low-citation answers as "this comes from a doc without strong code grounding."

**Cost:** small. Computed at scan time, surfaced via `wiki_scan` output.

**Tradeoff:** relies on citation density correlating with correctness, which is a weak proxy. A heavily-cited doc could still be wrong; a sparsely-cited doc could still be right. But on average it should track.

---

### Proposal 10 — The Karpathy gap (process, not code)

The Karpathy methodology actually includes human review at every step. The wiki RAG system as built skipped that part — `wiki_index` just runs and writes. Reintroducing a "review queue" closes the loop:

- `wiki_index` writes to `wiki/_pending/<path>` instead of `wiki/<path>`
- A separate `wiki_approve` tool moves entries from `_pending/` to the live tree after a human review
- `wiki_scan` distinguishes pending from approved entries
- `source_read grep wiki/` only matches approved entries by default; pending requires an explicit flag

**Why this matters:** it's the most labor-intensive but also the most effective. It puts a human gate exactly where the v1.0 incident bypassed the human gate. Every other proposal is a heuristic; this is the actual fix to the actual failure mode.

**Cost:** significant. New tool, new schema, new workflow. Workflow friction every time the wiki is rebuilt.

**Open decision:** is this worth the friction, given that you're already spot-checking wiki entries manually?

---

## Ranked recommendation

If the goal is **maximum impact for minimum effort**, in order:

1. **Proposal 3a — Path-citation validation** (~20 LOC, catches `src/taskmaster.ts`-class fabrications automatically, zero extra LLM cost). Single biggest mechanical lever.
2. **Proposal 2 — Strengthen the indexing prompt** with the "do not draw on training data" + "numbers must appear verbatim" + "vague source = vague summary" rules (zero LOC, zero cost).
3. **Proposal 1 — Global "code claims require code reads" rule**, scoped to source-plugin or source-doc edits. Catches the failure at creation time, not just at indexing time.
4. **Proposal 2 (tail end) — Drop the "still produce a valid entry" instruction** for trivial docs. One-line prompt fix that removes the pressure to invent.
5. **Proposal 8 — Add provenance fields** to frontmatter. Mechanical, cheap, makes future audits easier.

Then, if those work and you want to go further:

6. **Proposal 4 — Two-pass hostile review** (opt-in, or auto-triggered when mechanical checks flag something).
7. **Proposal 5 — `kind:` field with kind-specific prompts.**
8. **Proposal 7 — Pointer-only mode** for high-risk doc kinds.
9. **Proposal 10 — `wiki/_pending/` review queue.** The most effective, the most expensive in workflow friction.

---

## The deeper question

There's a meta-issue worth naming explicitly:

> **The LLM doing the indexing is the same kind of LLM that wrote the bad source doc.** Asking it to detect its own failure mode is asking a fish to notice water.

The mechanical checks (path validation, numerical cross-check) are valuable specifically because they're *not* LLM judgment — they're deterministic. The two-pass review is valuable because it uses a *different* system prompt that breaks the indexer's frame. The human review queue is valuable because it brings in a non-LLM verifier entirely.

**The most robust answer is layered.** No single intervention is sufficient. A defense in depth would combine:

- **Idea 1** at the prompt level (cheapest, broadest, sets the cultural default)
- **Idea 3a** at the write/index level (mechanical, deterministic, catches the easy fabrications)
- **Idea 4** as an opt-in escalation (LLM-on-LLM hostile review when something looks fishy)
- **Idea 8** for audit trails (so we can re-evaluate trust later when models improve)

Each layer covers a different failure mode. Each one is cheap individually. None is sufficient alone.

---

## Open decisions (things we need to choose)

1. **Where to enforce the discipline** — at writing time, at indexing time, at retrieval time, or all three?
2. **LLM cost budget** per indexed file — does a 2x verification pass justify the cost, and if so, always-on or only on flagged cases?
3. **Strict refusal vs warnings** for mechanical-check failures — do we block bad entries from being written, or write them with a warnings field?
4. **Schema attachment** — keep the current free-form summary shape, or move to a structured `kind:`-based schema with kind-specific rules?
5. **Provenance visibility** — `indexed_by_model` field in frontmatter: does it help, or does it create weird recursive distrust when one LLM grep's an entry produced by a smaller LLM?
6. **Human review gate** — is `wiki/_pending/` worth the workflow friction? Given that the v1.0 incident happened *because* there was no human gate, the answer is probably yes — but the friction is real.

---

## Validation suite

The TaskMaster failure has given us a perfect natural experiment. The original bad source doc and bad wiki entry are preserved in git history at:

- Bad source doc: `git show b6cdaa2:docs/TASKMASTER.md`
- Bad wiki entry: `git show 2938874:wiki/docs/TASKMASTER.md` (in some commits before deletion)
- Bad release section: `git show b6cdaa2:releases/1.0.0.md` (TaskMaster section)

Any proposed fix can be evaluated against this fixture: take the bad source doc, run it through the proposed pipeline, and measure whether the fix would have caught it. If the fix lets the original hallucination through, the fix is insufficient. This is a clean, reproducible regression test.

---

## Status of related work

- The verification rule itself (require code citations for architectural claims) was added to [`WIKI_KNOWLEDGE.md`](WIKI_KNOWLEDGE.md) Trust & Verification section in commit `a3c5baa`, including a "failure mode this guards against" paragraph that explicitly names the TaskMaster incident as the motivating case.
- The corrected `docs/TASKMASTER.md` (commit `a3c5baa`), `docs/WEB_RESEARCH.md` (commit `9b66874`), and `releases/1.0.0.md` rewrites are the empirical proof that the discipline produces accurate docs when followed manually. The question this design discussion exists to answer is: **how do we make following the discipline automatic?**
