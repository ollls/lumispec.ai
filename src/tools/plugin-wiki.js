import { mkdir, writeFile, readFile, stat, access, readdir } from 'fs/promises';
import { resolve, relative, dirname } from 'path';
import { execSync } from 'child_process';
import config from '../config.js';
import { collectChatCompletion } from '../services/llm.js';
import { validateCitations } from './index.js';

// ── Constants ────────────────────────────────────────────

const WIKI_SUBDIR = 'wiki';
const IGNORE_DIRS = ['node_modules', '.git', 'data', 'logs', 'dist', 'build', '.next', 'venv', '__pycache__'];

// Reserved top-level subdirs under wiki/ for non-file-derived entries.
// These are NOT matched against source files — they hold standalone wiki entries.
//   _notes — wiki_note output (future Stage)
//   _lens  — wiki_lens output (future Stage 2), structure: _lens/<color>/<rel-path>
//   _conv  — conversation-derived entries (future)
//   _web   — web-fetch-derived entries (future)
const RESERVED_WIKI_PREFIXES = ['_notes', '_lens', '_conv', '_web'];

// ── Path helpers ─────────────────────────────────────────

function getRoots() {
  if (!config.sourceDir) return null;
  const sourceRoot = resolve(config.sourceDir);
  const wikiRoot = resolve(sourceRoot, WIKI_SUBDIR);
  return { sourceRoot, wikiRoot };
}

function wikiPathFor(sourceRoot, wikiRoot, absMdPath) {
  const rel = relative(sourceRoot, absMdPath);
  return resolve(wikiRoot, rel);
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function listMarkdownFiles(sourceRoot) {
  // Use git if available (respects .gitignore), fall back to find
  try {
    const out = execSync('git ls-files "*.md" "*.markdown"', {
      cwd: sourceRoot, encoding: 'utf-8', timeout: 5000,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    const excludes = IGNORE_DIRS.map(d => `-not -path "*/${d}/*"`).join(' ');
    const out = execSync(`find . -type f \\( -name "*.md" -o -name "*.markdown" \\) ${excludes}`, {
      cwd: sourceRoot, encoding: 'utf-8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    });
    return out.split('\n').filter(Boolean).map(s => s.replace(/^\.\//, ''));
  }
}

// ── Frontmatter parsing & enforcement ────────────────────

// Tolerant regex-based parser. Returns { key: rawStringValue } for simple
// `key: value` lines between `---` delimiters. Unknown keys pass through.
// Does NOT validate YAML, does NOT type-coerce. Forward-compat by design.
function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return null;
  const closeIdx = content.indexOf('\n---', 4);
  if (closeIdx === -1) return null;
  const block = content.slice(4, closeIdx);
  const out = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Forcibly overwrite source: and last_updated: in the frontmatter block.
// Strips any existing instances and re-inserts at the top in canonical order,
// preserving all other frontmatter lines verbatim.
function enforceFrontmatterFields(summary, { source, last_updated }) {
  if (!summary || !summary.startsWith('---')) return summary;
  const closeIdx = summary.indexOf('\n---', 4);
  if (closeIdx === -1) return summary;

  const block = summary.slice(4, closeIdx);
  const rest = summary.slice(closeIdx + 1); // starts with "---\n...body"

  const filtered = block
    .split('\n')
    .filter(line => !/^source\s*:/i.test(line) && !/^last_updated\s*:/i.test(line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');

  const newBlock = `source: ${source}\nlast_updated: ${last_updated}${filtered ? '\n' + filtered : ''}`;
  return `---\n${newBlock}\n${rest}`;
}

// ── Wiki tree walking & classification ───────────────────

async function walkWikiTree(wikiRoot) {
  if (!await exists(wikiRoot)) return [];
  const entries = [];
  let items;
  try {
    items = await readdir(wikiRoot, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  for (const item of items) {
    if (!item.isFile()) continue;
    if (!/\.(md|markdown)$/i.test(item.name)) continue;
    const parent = item.parentPath || item.path;
    const absPath = resolve(parent, item.name);
    const relFromWikiRoot = relative(wikiRoot, absPath);
    const firstSegment = relFromWikiRoot.split(/[/\\]/)[0];
    entries.push({ absPath, relFromWikiRoot, firstSegment });
  }
  return entries;
}

// Decide whether a wiki entry is file-derived or one of the reserved kinds.
function classifyWikiEntry(relFromWikiRoot, firstSegment) {
  if (!RESERVED_WIKI_PREFIXES.includes(firstSegment)) {
    return { kind: 'file' };
  }
  if (firstSegment === '_notes') return { kind: 'note' };
  if (firstSegment === '_lens') {
    const parts = relFromWikiRoot.split(/[/\\]/);
    return { kind: 'lens', color: parts[1] || null };
  }
  if (firstSegment === '_conv') return { kind: 'conv' };
  if (firstSegment === '_web') return { kind: 'web' };
  return { kind: 'unknown' };
}

// Read just enough of a wiki entry to extract its frontmatter.
async function readFrontmatterOnly(absPath) {
  try {
    const head = await readFile(absPath, 'utf-8');
    return parseFrontmatter(head.slice(0, 4096));
  } catch {
    return null;
  }
}

// ── LLM index entry generation ───────────────────────────

// The strict-mode rules are appended to the indexing system prompt when
// cite mode is active. They explicitly counter the failure modes that
// produced the v1.0 TaskMaster hallucination: paraphrase-as-invention,
// numerical fabrication, and training-data inference about projects the
// LLM has never read. See docs/KNOWLEDGE_HARDENING.md for the full
// design discussion.
const CITE_INDEX_RULES = `

STRICT MODE (Cite mode is on for this indexing run):
- Do NOT invent details. If the source document is vague, your summary must also be vague — do not crystallize ambiguity into specifics.
- Numerical claims (constants, percentages, byte counts, line counts, durations, limits) must appear in the source verbatim. Do not paraphrase or round numbers.
- Do NOT draw on general LLM/AI literature, training-data knowledge, or analogies to other projects. The only source of truth is the document I am providing. If the document does not mention X, X does not exist in this project.
- If the document refers to a file path, function name, or symbol that you would normally explain from training data, do NOT explain it. Just preserve the reference.
- Tags must use terminology that appears in the source document. Do not invent project-specific jargon.
- If the document has no real architectural content, return a stub entry with minimal tags and an empty key topics list. Do NOT invent topics to fill space.
- Key topics must be derivable from the document's own headings or explicit content. Do not synthesize topics that require external knowledge.`;

async function indexToWiki(relPath, fullContent, { cite = false } = {}) {
  const MAX_INPUT = 24000;
  const truncated = fullContent.length > MAX_INPUT;
  const body = truncated ? fullContent.slice(0, MAX_INPUT) + '\n\n[... truncated ...]' : fullContent;

  const baseSystem = `You produce compact wiki INDEX entries for markdown documents.
Output EXACTLY this format and nothing else — no preamble, no code fences around the whole thing:

---
source: file:${relPath}
last_updated: <iso-timestamp>
tags: [tag1, tag2, tag3]
answers:
  - "question this doc answers"
  - "another question"
---
# {short title}

{One dense paragraph (3-6 sentences) covering what the document is about, its scope, and the most important concrete facts/entities/APIs it contains. No fluff.}

## Key topics
- topic one — one-line note
- topic two — one-line note
- topic three — one-line note

Rules:
- The "source:" field uses a URI scheme. "file:..." means a markdown file under the project root. (Future schemes: conv:, web:, tool:.)
- The "last_updated:" field will be overwritten by the system after you respond — emit the placeholder verbatim.
- 5-8 tags, lowercase, hyphenated, specific (not "docs", "readme")
- 3-6 "answers" entries phrased as natural questions a user might ask
- 3-8 key topics, each with a brief note
- Do NOT reproduce large code blocks, tables, or the full content — this is an INDEX, not a copy
- If the document is trivial (< 200 chars) or has no real content, return a stub entry with empty key topics. Do NOT invent topics to fill space.`;

  const system = cite ? baseSystem + CITE_INDEX_RULES : baseSystem;

  const user = `Document path: ${relPath}
Length: ${fullContent.length} chars${truncated ? ' (truncated for summarization)' : ''}

\`\`\`markdown
${body}
\`\`\``;

  const { content } = await collectChatCompletion([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { signal: AbortSignal.timeout(90000), maxTokens: 1200, temperature: cite ? 0.1 : 0.2 });

  return (content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ── Plugin ───────────────────────────────────────────────

export default {
  group: 'wiki',
  label: 'Wiki Index',
  description: 'Two-tier documentation index for project markdown files. To trigger: tell the LLM "build the wiki" or "scan and index project markdown" — it runs wiki_scan, then loops wiki_index over each file (announcing scope upfront). To rebuild stale entries: "update the wiki". Once built, the LLM auto-greps wiki/ before answering questions about project docs — no command needed.',
  dependencies: ['source'],
  condition: () => !!config.sourceDir,
  routing: [
    '- Question about stored documentation → grep wiki/ first (via source_read), then read the full source only if the overview is insufficient',
    '- "Build/update wiki" requests → use wiki_scan then wiki_index one file at a time',
  ],
  prompt: `## Wiki Index (two-tier docs)
A compressed overview of project markdown files lives under \`wiki/\` inside the source directory. Each entry is a short YAML-frontmatter + paragraph + key topics, with a \`source:\` pointer back to the full original markdown. The pointer uses a URI scheme — \`file:<path>\` for file-derived entries (future schemes: \`conv:\`, \`web:\`, \`tool:\`).

Reserved subdirs under \`wiki/\` (do NOT treat as file-derived entries):
- \`wiki/_notes/\` — conversation-derived notes (future)
- \`wiki/_lens/<color>/\` — color-lens re-framings (future Stage 2)
- \`wiki/_conv/\`, \`wiki/_web/\` — reserved for future use

Retrieval pattern (READ):
1. When the user asks about something that might be in the docs, first grep \`wiki/\` (use source_read grep) for relevant overviews.
2. Read the matched wiki overview(s) — they are cheap and sufficient for most questions.
3. ONLY if the overview is not enough, follow its \`source:\` field and read the full original markdown.

Build pattern (WRITE) — the human MUST always know whether work remains:
1. Call \`wiki_scan\` to get the unified view: \`fileEntries\` (with \`compressed\`/\`stale\` flags), \`orphans\`, \`nextBatch\` (uncompressed file paths, capped), and \`hasMore\` (boolean — true if more uncompressed files exist than \`nextBatch\` can hold).
2. **BEFORE indexing anything**, announce the scope to the user in a single explicit sentence:
   - State \`summary.uncompressed\` (total uncompressed files), \`nextBatch.length\` (files in this batch), and whether \`hasMore\` is true.
   - Example: *"Found 22 uncompressed markdown files. Processing the first 20 now; 2 more remain after this batch."*
   - If everything fits: *"Found 8 uncompressed files. Processing all 8 now."*
3. Iterate over \`nextBatch\` calling \`wiki_index\` with one path at a time, sequentially. Count your own \`wiki_index\` calls as you go.
4. For stale entries (\`stale: true\`), call \`wiki_index\` with \`force: true\` to rebuild.
5. **WHEN YOU STOP** (whether by completing the batch, hitting the tool round limit, or any other reason), end your message with an explicit status line so the human knows whether to continue:
   - If you indexed fewer files than the batch contained, OR \`hasMore\` was true: *"Indexed X of Y total uncompressed files. Say 'continue' to process the remaining Z."*
   - If you indexed the entire batch AND \`hasMore\` was false: *"All N files indexed. Wiki build complete."*
6. NEVER report "done" or "complete" without verifying every uncompressed file was actually processed. The human relies on your status line to know whether more work remains — if you get cut off mid-batch, say so honestly.
7. Skip entries that are already up-to-date unless the user explicitly asks for a full rebuild.`,
  tools: {
    wiki_scan: {
      description: 'Scan project markdown files AND existing wiki entries, returning a unified view: file-derived entries with compressed/stale status, reserved-subdir entries (notes/lenses), orphaned wiki entries, and a nextBatch of uncompressed paths for the build loop. No parameters.',
      parameters: {},
      execute: async () => {
        const roots = getRoots();
        if (!roots) return { error: 'SOURCE_DIR not configured' };
        const { sourceRoot, wikiRoot } = roots;

        // 1. Source markdown files
        let sourceFiles;
        try {
          sourceFiles = await listMarkdownFiles(sourceRoot);
        } catch (err) {
          return { error: `Failed to list markdown files: ${err.message}` };
        }
        const wikiRel = relative(sourceRoot, wikiRoot);
        const filteredSources = sourceFiles.filter(f => !f.startsWith(wikiRel + '/') && f !== wikiRel);

        // 2. Walk the wiki tree (may not exist yet)
        const wikiItems = await walkWikiTree(wikiRoot);
        const wikiFileEntriesMap = new Map();   // relFromWikiRoot -> entry meta (for kind: 'file')
        const noteEntries = [];
        const lensEntries = [];

        for (const item of wikiItems) {
          const cls = classifyWikiEntry(item.relFromWikiRoot, item.firstSegment);
          if (cls.kind === 'file') {
            wikiFileEntriesMap.set(item.relFromWikiRoot, item);
          } else if (cls.kind === 'note') {
            const fm = await readFrontmatterOnly(item.absPath);
            noteEntries.push({
              wikiPath: relative(sourceRoot, item.absPath),
              source: fm?.source || null,
              last_updated: fm?.last_updated || null,
            });
          } else if (cls.kind === 'lens') {
            const fm = await readFrontmatterOnly(item.absPath);
            lensEntries.push({
              wikiPath: relative(sourceRoot, item.absPath),
              color: cls.color,
              source: fm?.source || null,
              last_updated: fm?.last_updated || null,
            });
          }
          // 'conv', 'web', 'unknown' kinds are silently ignored in v1
        }

        // 3. Build fileEntries by cross-referencing source files against wiki entries
        const fileEntries = [];
        const matchedWikiKeys = new Set();
        for (const rel of filteredSources) {
          const abs = resolve(sourceRoot, rel);
          let size = 0;
          let sourceMtimeIso = null;
          try {
            const s = await stat(abs);
            size = s.size;
            sourceMtimeIso = new Date(s.mtimeMs).toISOString();
          } catch { continue; }

          // Defensive: skip source paths that would collide with reserved wiki prefixes
          const firstSeg = rel.split(/[/\\]/)[0];
          if (RESERVED_WIKI_PREFIXES.includes(firstSeg)) continue;

          const wikiAbs = wikiPathFor(sourceRoot, wikiRoot, abs);
          const relFromWikiRoot = relative(wikiRoot, wikiAbs);
          const wikiItem = wikiFileEntriesMap.get(relFromWikiRoot);
          let compressed = false;
          let stale = false;
          let last_updated = null;
          let wikiSize = 0;

          if (wikiItem) {
            matchedWikiKeys.add(relFromWikiRoot);
            compressed = true;
            try {
              const ws = await stat(wikiItem.absPath);
              wikiSize = ws.size;
            } catch {}
            const fm = await readFrontmatterOnly(wikiItem.absPath);
            last_updated = fm?.last_updated || null;
            if (last_updated) {
              const wikiTs = Date.parse(last_updated);
              if (!isNaN(wikiTs) && wikiTs < Date.parse(sourceMtimeIso)) stale = true;
            } else {
              // Pre-refactor entries without last_updated → treat as stale to force rebuild
              stale = true;
            }
          }

          fileEntries.push({
            source: `file:${rel}`,
            path: rel,
            wikiPath: relative(sourceRoot, wikiAbs),
            sourceSize: size,
            wikiSize,
            compressed,
            stale,
            last_updated,
          });
        }

        // 4. Orphans: file-kind wiki entries whose expected source no longer exists
        const orphans = [];
        for (const [relFromWikiRoot, item] of wikiFileEntriesMap) {
          if (matchedWikiKeys.has(relFromWikiRoot)) continue;
          const fm = await readFrontmatterOnly(item.absPath);
          orphans.push({
            wikiPath: relative(sourceRoot, item.absPath),
            source: fm?.source || `file:${relFromWikiRoot}`,
          });
        }

        // 5. Compute summary + nextBatch
        const compressedCount = fileEntries.filter(e => e.compressed && !e.stale).length;
        const staleCount = fileEntries.filter(e => e.stale).length;
        const uncompressedCount = fileEntries.filter(e => !e.compressed).length;
        const nextBatch = fileEntries.filter(e => !e.compressed).map(e => e.path).slice(0, 20);

        return {
          wikiRoot: wikiRel || 'wiki',
          summary: {
            total: fileEntries.length,
            compressed: compressedCount,
            stale: staleCount,
            uncompressed: uncompressedCount,
            orphans: orphans.length,
            notes: noteEntries.length,
            lenses: lensEntries.length,
          },
          fileEntries,
          noteEntries,
          lensEntries,
          orphans,
          nextBatch,
          hasMore: uncompressedCount > nextBatch.length,
        };
      },
    },

    wiki_index: {
      description: 'Index a single markdown file into a wiki overview entry. Reads the source markdown, asks the LLM to produce a compact YAML-frontmatter + paragraph + key-topics summary, then writes it to wiki/<same-relative-path>. The plugin enforces correct "source:" (file:URI) and "last_updated:" (ISO timestamp) fields. Use wiki_scan first to discover files. Processes ONE file per call — loop externally.\n\nParameters:\n- path: relative path of the markdown file under SOURCE_DIR (e.g. "docs/api.md")\n- force: if true, overwrite an existing wiki entry (default: false). Use this to rebuild stale entries.',
      parameters: {
        path: 'string (relative markdown path under SOURCE_DIR)',
        force: 'boolean (optional, overwrite existing entry, default false)',
      },
      execute: async ({ path: relPath, force = false }, context) => {
        if (!relPath?.trim()) return { error: 'path is required' };
        const roots = getRoots();
        if (!roots) return { error: 'SOURCE_DIR not configured' };
        const { sourceRoot, wikiRoot } = roots;
        const cite = !!context?.cite;

        // Defensive: refuse paths that would collide with reserved wiki prefixes
        const firstSeg = relPath.split(/[/\\]/)[0];
        if (RESERVED_WIKI_PREFIXES.includes(firstSeg)) {
          return { error: `Path uses a reserved wiki prefix (${firstSeg}). These subdirs are for non-file-derived entries.` };
        }

        const absSource = resolve(sourceRoot, relPath);
        if (!absSource.startsWith(sourceRoot)) return { error: 'Path escapes source directory' };
        if (!/\.(md|markdown)$/i.test(absSource)) return { error: 'Not a markdown file' };

        const absWiki = wikiPathFor(sourceRoot, wikiRoot, absSource);
        if (!absWiki.startsWith(wikiRoot)) return { error: 'Wiki path escapes wiki directory' };

        if (!force && await exists(absWiki)) {
          return {
            skipped: true,
            reason: 'wiki entry already exists (pass force: true to rebuild)',
            wikiPath: relative(sourceRoot, absWiki),
          };
        }

        let content;
        let sourceStat;
        try {
          content = await readFile(absSource, 'utf-8');
          sourceStat = await stat(absSource);
        } catch (err) {
          return { error: `Failed to read source: ${err.message}` };
        }

        if (context?.sendSSE) {
          context.sendSSE('tool_status', { message: `Indexing ${relPath}${cite ? ' (cite mode)' : ''}...` });
        }

        let summary;
        try {
          summary = await indexToWiki(relPath, content, { cite });
        } catch (err) {
          return { error: `LLM summarization failed: ${err.message}` };
        }

        if (!summary || !summary.startsWith('---')) {
          return { error: 'LLM returned invalid summary (missing frontmatter)', raw: summary?.slice(0, 200) };
        }

        // Forcibly enforce source: and last_updated: with known-correct values.
        // This makes LLM correctness on these fields belt-and-suspenders.
        const sourceUri = `file:${relPath}`;
        const lastUpdatedIso = new Date(sourceStat.mtimeMs).toISOString();
        let patched = enforceFrontmatterFields(summary, {
          source: sourceUri,
          last_updated: lastUpdatedIso,
        });

        // Cite mode: validate any (file:line) citations in the produced
        // entry against the filesystem before writing. Broken citations
        // (path doesn't exist, or line number outside the file) are a
        // hard signal of fabrication — refuse the write entirely.
        if (cite) {
          const broken = await validateCitations(patched, sourceRoot);
          if (broken.length > 0) {
            return {
              error: `Cite mode: refused to write wiki entry — ${broken.length} broken citation(s) detected. The LLM produced citations that don't resolve on disk. Either fix the source document, run wiki_index without cite mode, or rebuild after the cited code lands.`,
              brokenCitations: broken,
              path: relPath,
              wikiPath: relative(sourceRoot, absWiki),
            };
          }
          // Stamp cite_mode into the frontmatter so future readers know
          // this entry was produced under strict mode.
          patched = patched.replace(
            /^---\nsource: /,
            '---\ncite_mode: true\nsource: '
          );
        }

        try {
          await mkdir(dirname(absWiki), { recursive: true });
          await writeFile(absWiki, patched, 'utf-8');
        } catch (err) {
          return { error: `Failed to write wiki entry: ${err.message}` };
        }

        return {
          ok: true,
          source: sourceUri,
          path: relPath,
          wikiPath: relative(sourceRoot, absWiki),
          sourceSize: content.length,
          wikiSize: patched.length,
          last_updated: lastUpdatedIso,
          cite_mode: cite || undefined,
          ratio: `${((patched.length / Math.max(content.length, 1)) * 100).toFixed(1)}%`,
          _markdown: `**Indexed** \`${relPath}\` → \`${relative(sourceRoot, absWiki)}\`${cite ? ' (cite mode)' : ''} (${content.length} → ${patched.length} chars)\n\n\`\`\`markdown\n${patched}\n\`\`\``,
        };
      },
    },
  },
};
