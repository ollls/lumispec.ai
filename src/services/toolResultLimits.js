// Ceilings on what one tool call may put into the prompt. 2026-11-08: `source_read tree` on
// ~/llama.cpp returned 7,087 paths — 428K chars, ~110K tokens — in one result; the next request was
// 131K tokens against a 64K slot and llama-server answered 400. Nothing between the tool and the
// prompt could shrink it: `tree` had no cap, the executor serialized results whole, and the
// context wind-down only trims results older than the newest three. All pure.

/** Max chars of one serialized tool result handed to the model (and stored on the message). */
export const MAX_TOOL_RESULT_CHARS = 50000;

/** Max paths a `tree` listing returns before it is summarized. */
export const MAX_TREE_FILES = 300;

/**
 * A file list the model can use whatever the repository size: every path when there are few,
 * otherwise the top-level layout with counts, the first `max` paths, and how to see more.
 * `files` are './'-prefixed or bare relative paths, sorted.
 */
export function summarizeTree(files, { root = '', max = MAX_TREE_FILES, subdir = '' } = {}) {
  const clean = files.map(f => f.replace(/^\.\//, ''));
  const out = { root, fileCount: clean.length };
  if (subdir) out.path = subdir;
  if (clean.length <= max) {
    out.files = clean;
    return out;
  }
  const dirs = new Map();
  let rootFiles = 0;
  for (const f of clean) {
    const slash = f.indexOf('/');
    if (slash === -1) { rootFiles++; continue; }
    const d = f.slice(0, slash);
    dirs.set(d, (dirs.get(d) || 0) + 1);
  }
  out.truncated = true;
  out.layout = [...dirs.entries()].sort((a, b) => b[1] - a[1]).map(([dir, n]) => `${dir}/ (${n} files)`);
  if (rootFiles) out.layout.unshift(`<root> (${rootFiles} files)`);
  out.files = clean.slice(0, max);
  out.note = `${clean.length} files — only the first ${max} are listed. For more, call tree with "path" set to one subdirectory (e.g. "${[...dirs.keys()][0] || 'src'}"), or use grep for a file name or symbol.`;
  return out;
}

/**
 * Cap one serialized tool result. Short results pass through unchanged. Over the cap, the model
 * gets a JSON object naming the original size and carrying the head of the original text, so a
 * runaway result costs at most `max` chars whatever the tool returned.
 */
export function capToolResult(str, max = MAX_TOOL_RESULT_CHARS) {
  const s = String(str ?? '');
  if (s.length <= max) return s;
  // The head is JSON inside JSON, so its quotes escape to \" — shrink it until the whole
  // envelope is within the cap (plus the envelope's own few hundred chars).
  let head = s.slice(0, max);
  const envelope = () => JSON.stringify({
    _truncated: true,
    originalChars: s.length,
    keptChars: head.length,
    note: `This tool result was ${s.length} chars — over the ${max}-char ceiling — so only its beginning follows. Ask for less: a subdirectory, a grep, a smaller range or fewer rows.`,
    head,
  });
  let out = envelope();
  while (out.length > max + 400 && head.length > 100) {
    head = head.slice(0, Math.floor(head.length * 0.9));
    out = envelope();
  }
  return out;
}

const isToolResult = (m) => m.role === 'user' && typeof m.content === 'string'
  && (/^(Tool "|⚠ TOOL ERROR|⚠ DENIED)/.test(m.content) || /REMINDER: tool calls MUST use/.test(m.content));

/**
 * Trim EVERY tool-result message longer than `cap` to `cap` chars — newest included. The
 * wind-down's `trimOldToolResults` keeps the newest three whole; when the newest are what blew
 * the budget, this is the second pass. Returns chars freed. Pure apart from mutating `messages`.
 */
export function trimLargeToolResults(messages, cap) {
  let freed = 0;
  messages.forEach((m, i) => {
    if (!isToolResult(m) || m.content.length <= cap) return;
    const c = m.content;
    messages[i] = { ...m, content: `${c.slice(0, cap)}\n… [${c.length - cap} chars trimmed to fit the context]` };
    freed += c.length - cap;
  });
  return freed;
}

/**
 * Shrink tool results until the prompt fits: pass 1 trims old results (`trimOld`), then every
 * result is cut to descending caps until `count(messages)` is at or under `target`.
 * `count` is async (llama's /tokenize). Returns { promptTokens, freed, passes }.
 */
export async function fitToolResultsToContext(messages, { count, target, trimOld, caps = [4000, 1500, 400] }) {
  let freed = trimOld ? trimOld(messages) : 0;
  let promptTokens = await count(messages);
  let passes = 0;
  for (const cap of caps) {
    if (promptTokens <= target) break;
    const f = trimLargeToolResults(messages, cap);
    passes++;
    if (!f) continue;
    freed += f;
    promptTokens = await count(messages);
  }
  return { promptTokens, freed, passes };
}
