# Wiki Knowledge Management System

## 🎯 Karpathy-Style LLM Wiki

LLM Workbench implements Andrej Karpathy's vision of a **persistent, self-improving knowledge base** — an interlinked markdown wiki that sits between you and raw sources, incrementally built and maintained by LLMs.

### The Philosophy

> Instead of just retrieving from raw documents at query time, the LLM incrementally builds and maintains a persistent wiki — a structured, interlinked collection of markdown files that sits between you and the raw sources.

## 🔄 The Feedback Loop

### 1. Ask the Wiki

**Query existing knowledge:**

```
User: "How do I configure web research?"

System:
1. Grep wiki/ for relevant entries (fast, cheap)
2. Read matched wiki overviews
3. Follow source: pointers if more detail needed
4. Synthesize answer from compressed knowledge
```

### 2. Identify Gaps

**When wiki is incomplete:**

```
System detects:
- No matching wiki entries found
- Stale entries (source modified after compression)
- Missing connections between concepts
- Outdated information
```

### 3. Research & Validate

**Fill knowledge gaps:**

```
System:
1. web_search → Find current information
2. web_fetch → Extract full content
3. Validate against multiple sources
4. Cross-reference with existing docs
```

### 4. Update Source Documentation

**Edit authoritative sources:**

```
System:
1. source_read → Locate relevant file
2. source_edit → Apply targeted changes
3. source_write → Create new documentation if needed
4. Verify changes with source_test (if applicable)
```

### 5. Rebuild Wiki

**Re-index compressed knowledge:**

```
User: "rebuild wiki"

System:
1. wiki_scan → Discover all uncompressed/stale files
2. Report scope: "Found X uncompressed files"
3. wiki_index (iterative) → Process one file at a time
4. Track progress: "Indexed 5 of 12 files"
5. Confirm completion: "All 12 files indexed. Wiki build complete."
```

### 6. Commit & Sync

**Version control knowledge:**

```
System:
1. source_git status → Check what changed
2. source_git add wiki/ → Stage wiki changes
3. source_git commit -m "docs: update knowledge base" → Commit
4. source_git push → Sync to GitHub (requires approval)
```

## 📊 Complete Workflow Example

### Scenario: Document an existing subsystem

```
Step 1: USER REQUEST
────────────────────────────────────────
User: "Document how the wiki retrieval pattern works"

Step 2: GROUND THE CLAIMS IN CODE
────────────────────────────────────────
System:
- source_read tree → list relevant files
- source_read read("src/tools/plugin-wiki.js")
- source_read read("CLAUDE.md") for the authoritative description
- source_read grep("wiki_scan|wiki_index", glob: "src/**/*.js")

Step 3: WRITE THE SOURCE DOC
────────────────────────────────────────
System:
- source_edit("docs/WIKI.md") with cited file:line references
  for every architectural claim (no hand-wavy diagrams)

Step 4: INDEX WIKI
────────────────────────────────────────
System:
- wiki_index(path: "docs/WIKI.md", force: true)
- Creates/refreshes: wiki/docs/WIKI.md

Step 5: COMMIT
────────────────────────────────────────
System:
- source_git add docs/WIKI.md wiki/docs/WIKI.md
- source_git commit -m "docs: document wiki retrieval pattern"
- source_git push (requires approval)
```

The non-negotiable rule: every architectural claim in a source doc must point at the file and line in the codebase that backs it up. The wiki indexer summarizes whatever the source doc says — it cannot detect hallucinations. Verification has to happen *before* `source_edit` writes the doc, not after.

## 🔍 Query Patterns

### Pattern 1: Simple Lookup

```
User: "How do I configure web research?"

Flow:
wiki/docs/WEB_RESEARCH.md → Fast answer from compressed index
```

### Pattern 2: Multi-Source Synthesis

```
User: "What are all the ways to manage context in this system?"

Flow:
1. Grep wiki/ for "context"
2. Read: wiki/docs/TASKMASTER.md, wiki/docs/PLUGIN.md
3. Synthesize answer from multiple sources
```

### Pattern 3: Gap Detection → Research → Update

```
User: "How do I use the browser mode for web fetch?"

Flow:
1. Grep wiki/ → No browser mode details found
2. web_search("got-scraping Puppeteer stealth mode")
3. source_read("src/web.ts") → Verify implementation
4. source_edit("docs/WEB_RESEARCH.md") → Add browser section
5. wiki_index("docs/WEB_RESEARCH.md") → Re-compress
6. Answer user with updated knowledge
```

## 🛠️ Tool Suite for Wiki Management

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `wiki_scan` | Discover uncompressed/stale files | Before bulk rebuild |
| `wiki_index` | Compress single file to wiki | After source edit |
| `source_read` | Browse source documentation | Before editing |
| `source_edit` | Targeted documentation updates | When fixing gaps |
| `source_write` | Create new documentation | New features |
| `web_search` | Find external references | Validate current info |
| `web_fetch` | Extract full content | Deep research |
| `source_git` | Version control | After updates |

## 📋 Best Practices

### 1. Keep Source of Truth

- **`docs/`** = Authoritative source (full detail)
- **`wiki/`** = Compressed index (fast queries)
- Always update `docs/`, then rebuild `wiki/`

### 2. Validate External Claims

- Use `web_search` + `web_fetch` for time-sensitive info
- Cross-reference with 2+ sources
- Cite sources in documentation

### 3. Rebuild After Changes

```
Every source_edit or source_write → wiki_index
Every batch of changes → wiki_scan + wiki_index loop
```

### 4. Track Progress Explicitly

```
"Found 12 uncompressed files. Processing all 12 now."
"Indexed 5 of 12 files. Say 'continue' to process remaining 7."
"All 12 files indexed. Wiki build complete."
```

### 5. Commit Frequently

```
After each feature doc → commit + push
Before major rebuilds → commit intermediate state
```

## 🚀 Quick Commands

### Rebuild Entire Wiki

```bash
wiki_scan
wiki_index (loop over nextBatch)
```

### Add New Documentation

```bash
source_write (path: "docs/FEATURE.md")
wiki_index (path: "docs/FEATURE.md")
```

### Update Existing Documentation

```bash
source_read (path: "docs/EXISTING.md")
source_edit (path, old_string, new_string)
wiki_index (path: "docs/EXISTING.md")
```

### Research & Fill Gaps

```bash
web_search (query: "topic")
web_fetch (url: "relevant_url")
source_edit (add new section)
wiki_index (recompress)
```

## 🎓 Karpathy Alignment

### What This System Does Right

✅ **Persistent wiki** — Markdown files that accumulate knowledge  
✅ **LLM-maintained** — System reads, updates, expands docs  
✅ **Interlinked** — `source:` pointers connect compressed ↔ full  
✅ **Incremental** — `wiki_index` processes one file at a time  
✅ **Queryable** — Grep `wiki/` first for fast answers  
✅ **Version-controlled** — Git tracks all knowledge evolution  

### What Makes It Unique

- **Dual-tier RAG**: Compressed overviews + full source fallback
- **Self-aware**: System knows which docs are stale
- **Per-file isolation**: each `wiki_index` call summarizes its file via a stateless `collectChatCompletion` (24000-char input cap, 1200 output tokens, see `src/tools/plugin-wiki.js:184-187`). This is *not* TaskMaster and *not* the task pipeline — the loop runs in an ordinary chat conversation. The driving conversation still accumulates ~1KB per indexed file.
- **Web research**: Auto-validates against current internet info
- **Source tools**: Can modify its own documentation

## 📈 Trust & Verification

### The Challenge

> How do you trust AI-compiled knowledge? If the LLM hallucinates a connection between two concepts, that false link now lives in your wiki and could influence future queries.

### The Solution

1. **Source of Truth**: Original `docs/` files are human-reviewed
2. **Code citations are mandatory**: every architectural claim in a source doc must cite the file and line in the codebase that backs it up (e.g. `src/routes/taskProcessor.js:283`). Diagrams without code provenance are not allowed. The wiki indexer cannot detect hallucinated claims — it summarizes whatever the source doc says.
3. **Validation**: `web_search` + `web_fetch` verify external/current info
4. **Transparency**: `source:` field in each wiki entry shows where compressed data came from
5. **Version Control**: Git history tracks all changes
6. **Test Commands**: `source_test` validates code/docs alignment

### Verification Workflow

```
1. Read the relevant source files BEFORE editing the doc
   (source_read read / grep — not just web_search)
2. Draft the doc update with file:line citations for every claim
3. System proposes doc update via source_edit (diff preview shown)
4. User reviews diff preview and verifies citations resolve
5. If approved, commit with descriptive message
6. Re-run wiki_index --force on the changed source doc
7. Periodic audits: spot-check wiki entries against the cited code
```

### Failure mode this guards against

If a source doc claims "system X provides feature Y" without a code citation, and the LLM that wrote the doc was speculating, the wiki indexer will faithfully compress the false claim into a confident-sounding summary. Future queries against the wiki will then return the hallucination as authoritative knowledge. This is exactly the failure that motivated the v1.0 cleanup of the original `docs/TASKMASTER.md`. The fix is upstream of the wiki: do not let unverified claims into the source docs in the first place.

## 🎯 Next Steps

### For Users

1. **Query wiki first** — Fast answers from compressed knowledge
2. **Report gaps** — "This doc is missing X feature"
3. **Review before commit** — Always approve wiki changes
4. **Rebuild regularly** — `wiki_scan` → `wiki_index` after updates

### For Developers

1. **Document as you code** — `source_write` new features
2. **Reindex immediately** — `wiki_index` after every doc change
3. **Validate externally** — Use web research for current info
4. **Test changes** — `source_test` before committing

---

*"The interface between humans and AI is plain text."* — Andrej Karpathy
