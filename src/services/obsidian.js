// Obsidian export — renders a conversation as a Markdown note inside an Obsidian vault.
//
// One-way translation: the conversation store stays the source of truth and the note is
// regenerated from scratch on every export (see docs/OBSIDIAN.md). Nothing in the vault is
// ever deleted; a colour change moves (renames) the note, Obsidian updates links on move.
//
// renderNote() is pure (no fs) so it can be unit-tested against fixture conversations;
// exportConversation() does the vault I/O around it.

import { readFileSync, existsSync, statSync, readdirSync, mkdirSync, writeFileSync, renameSync, copyFileSync } from 'fs';
import { join, resolve, basename, extname, sep, dirname } from 'path';
import { homedir } from 'os';
import config from '../config.js';
import { replaceApplets } from './applets.js';

// ── Vault discovery ─────────────────────────────────

/** Where each Obsidian install keeps its vault registry: { vaults: { id: { path, ts, open? } } }. */
export function registryPaths(home = homedir()) {
  return [
    { kind: 'native', path: join(home, '.config', 'obsidian', 'obsidian.json') },
    { kind: 'flatpak', path: join(home, '.var', 'app', 'md.obsidian.Obsidian', 'config', 'obsidian', 'obsidian.json') },
    { kind: 'snap', path: join(home, 'snap', 'obsidian', 'current', '.config', 'obsidian', 'obsidian.json') },
  ];
}

/**
 * Read every registry and return the vaults Obsidian knows about, de-duplicated by path,
 * open vaults first, then most recently used. Missing or malformed registries are skipped.
 * `readText(path)` is injectable for tests.
 */
export function findVaults({ registries = registryPaths(), readText = p => readFileSync(p, 'utf-8') } = {}) {
  const byPath = new Map();
  for (const reg of registries) {
    let data;
    try { data = JSON.parse(readText(reg.path)); } catch { continue; }
    const vaults = data?.vaults && typeof data.vaults === 'object' ? data.vaults : {};
    for (const [id, v] of Object.entries(vaults)) {
      if (!v || typeof v.path !== 'string' || !v.path) continue;
      const entry = { id, path: v.path, ts: Number(v.ts) || 0, open: !!v.open, install: reg.kind };
      const prev = byPath.get(v.path);
      if (!prev) byPath.set(v.path, entry);
      else byPath.set(v.path, { ...(prev.ts >= entry.ts ? prev : entry), open: prev.open || entry.open });
    }
  }
  return [...byPath.values()].sort((a, b) => (b.open - a.open) || (b.ts - a.ts));
}

/**
 * Pick the vault to write into. Precedence: OBSIDIAN_VAULT in .env → the path saved on the
 * plugin card → the registry's open vault → the most recently used one. Returns
 * { path, source } or null when nothing usable exists (Obsidian not installed, or the chosen
 * folder is gone). The exporter short-circuits on null; nothing is ever created implicitly.
 */
export function resolveVault(cfg = {}, { envVault = config.obsidian?.vault || '', vaults = null, isDir = dirExists } = {}) {
  if (envVault) return isDir(envVault) ? { path: resolve(envVault), source: 'env' } : null;
  if (cfg.vault) return isDir(cfg.vault) ? { path: resolve(cfg.vault), source: 'card' } : null;
  const list = vaults || findVaults();
  for (const v of list) {
    if (isDir(v.path)) return { path: resolve(v.path), source: v.open ? 'registry-open' : 'registry-recent' };
  }
  return null;
}

function dirExists(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

// ── Rendering ───────────────────────────────────────

const TOOL_RESULT_LIMIT = 1500;

export function slugify(title) {
  const s = String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'untitled').slice(0, 60).replace(/-+$/, '');
}

export function noteBaseName(conv) {
  return `${slugify(conv.title)}-${String(conv.id).slice(0, 8)}`;
}

/** Relative note path inside the export folder: `<colour>/<slug>-<id8>.md`, or at the root without a colour. */
export function noteRelPath(conv) {
  const file = `${noteBaseName(conv)}.md`;
  return conv.session && /^[a-z]{1,16}$/.test(conv.session) ? join(conv.session, file) : file;
}

function yamlStr(v) { return JSON.stringify(String(v ?? '')); }
function yamlList(arr) { return `[${arr.map(yamlStr).join(', ')}]`; }

function localStamp(iso, timeZone) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // sv-SE gives "2026-10-25 12:40" — ISO-like, sorts, no locale surprises.
  return new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(d);
}

function callout(kind, title, body, { folded = true } = {}) {
  const head = `> [!${kind}]${folded ? '-' : ''} ${title}`;
  if (!body) return head;
  return head + '\n' + body.split('\n').map(l => (l ? `> ${l}` : '>')).join('\n');
}

function truncate(s, limit = TOOL_RESULT_LIMIT) {
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n… (truncated, ${s.length.toLocaleString('en-US')} chars)`;
}

/** Parse a stored tool result (JSON string or object) without throwing. */
function parseResult(result) {
  if (result && typeof result === 'object') return result;
  if (typeof result !== 'string') return null;
  try { return JSON.parse(result); } catch { return null; }
}

/** A short hint for the callout title: the query / url / filename the call was about. */
function toolHint(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  for (const k of ['query', 'url', 'path', 'filename', 'symbol', 'command']) {
    if (typeof parsed[k] === 'string' && parsed[k]) return ` — ${JSON.stringify(parsed[k].slice(0, 80))}`;
  }
  return '';
}

function renderToolUse(tu, ctx) {
  const parsed = parseResult(tu.result);
  const title = `🔧 ${tu.name}${toolHint(parsed)}`;
  if (parsed && parsed._autoSaved && parsed.savedFile?.filename) {
    const name = parsed.savedFile.filename;
    const link = ctx.availableFiles.has(name) ? `[[${name}]]` : `\`${name}\``;
    const note = parsed._note ? `\n${parsed._note}` : '';
    return callout('info', title, `Result saved to ${link}${note}`);
  }
  if (parsed && typeof parsed._markdown === 'string' && parsed._markdown.trim()) {
    return callout('info', title, truncate(parsed._markdown.trim()));
  }
  if (parsed && typeof parsed.error === 'string') {
    return callout('warning', title, truncate(parsed.error));
  }
  let raw;
  if (parsed && typeof parsed === 'object') {
    const clean = { ...parsed };
    for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
    raw = JSON.stringify(clean, null, 2);
  } else {
    raw = typeof tu.result === 'string' ? tu.result : JSON.stringify(tu.result ?? null);
  }
  return callout('info', title, '```json\n' + truncate(raw) + '\n```');
}

function renderToolUses(toolUses, ctx) {
  if (!ctx.includeTools || !Array.isArray(toolUses) || toolUses.length === 0) return [];
  return toolUses.map(tu => renderToolUse(tu, ctx));
}

function renderReasoning(reasoning, ctx) {
  if (!ctx.includeReasoning || !reasoning || !String(reasoning).trim()) return [];
  return [callout('note', 'Thinking', String(reasoning).trim())];
}

/** Cut <applet> blocks out of assistant text; each becomes an HTML sidecar linked from a callout. */
function extractApplets(text, ctx) {
  return replaceApplets(text, (type, body) => {
    const n = ctx.sidecars.filter(s => s.kind === 'applet').length + 1;
    const name = `${ctx.base}-applet-${n}.html`;
    ctx.sidecars.push({ kind: 'applet', name, content: wrapApplet(type, body) });
    return `\n${callout('example', `Applet (${type}) — [[${name}]]`)}\n`;
  });
}

function wrapApplet(type, body) {
  if (type === 'html') return body;
  if (type === 'chartjs') {
    return `<!doctype html><html><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script></head><body>${body}</body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

/** Rewrite `[label](/files/<name>)` links to wikilinks for the files the exporter copies alongside. */
function rewriteFileLinks(text, ctx) {
  if (ctx.availableFiles.size === 0) return text;
  return text.replace(/\[([^\]]*)\]\(\/files\/([^)\s]+)\)/g, (m, label, name) => {
    const clean = decodeURIComponent(name.split('?')[0]);
    if (!ctx.availableFiles.has(clean)) return m;
    return label && label !== clean ? `[[${clean}|${label}]]` : `[[${clean}]]`;
  });
}

function renderAssistantText(text, ctx) {
  let t = String(text ?? '').trim();
  if (!t) return '';
  t = extractApplets(t, ctx);
  t = rewriteFileLinks(t, ctx);
  return t.trim();
}

function renderUser(msg, ctx) {
  const c = msg.content;
  const text = typeof c === 'object' && c ? (c.text || '') : String(c ?? '');
  const images = typeof c === 'object' && c && Array.isArray(c.images) ? c.images : [];
  const out = [`## 🧑 ${localStamp(msg.sentAt, ctx.timeZone)}`.trimEnd()];
  if (text.trim()) out.push(text.trim());
  for (const img of images) {
    if (!img || typeof img.base64 !== 'string') continue;
    const n = ctx.sidecars.filter(s => s.kind === 'image').length + 1;
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' })[img.mimeType] || 'png';
    const name = `${ctx.base}-img-${n}.${ext}`;
    ctx.sidecars.push({ kind: 'image', name, base64: img.base64 });
    out.push(`![[${name}]]`);
  }
  return out.join('\n\n');
}

function renderStep(step, ctx, { heading, label }) {
  const out = [`${heading} ${label}`];
  if (step.error) out.push(callout('failure', 'Step failed', String(step.error), { folded: false }));
  out.push(...renderReasoning(step.reasoning, ctx));
  out.push(...renderToolUses(step.toolUses, ctx));
  const body = renderAssistantText(step.result, ctx);
  if (body) out.push(body);
  return out;
}

function renderTaskRun(taskRun, ctx) {
  const out = ['## 🎯 Pipeline'];
  taskRun.forEach((step, i) => {
    const label = `Step ${i + 1} — ${String(step.text || '').trim()}`;
    if (Array.isArray(step.subtasks)) {
      out.push(`### ${label}`);
      if (step.error) out.push(callout('failure', 'Group failed', String(step.error), { folded: false }));
      step.subtasks.forEach((sub, j) => {
        out.push(...renderStep(sub, ctx, { heading: '####', label: `Subtask ${i + 1}.${j + 1} — ${String(sub.text || '').trim()}` }));
      });
    } else {
      out.push(...renderStep(step, ctx, { heading: '###', label }));
    }
  });
  return out;
}

function renderAssistant(msg, ctx) {
  const c = msg.content;
  const out = [`## 🤖 ${localStamp(msg.sentAt, ctx.timeZone)}`.trimEnd()];
  if (typeof c === 'string' || !c) {
    const body = renderAssistantText(c, ctx);
    if (body) out.push(body);
    return out.join('\n\n');
  }
  if (Array.isArray(c.taskRun) && c.taskRun.length > 0) {
    // `text` is the flattened markdown of the same run — the structured form supersedes it.
    out.push(...renderTaskRun(c.taskRun, ctx));
    return out.join('\n\n');
  }
  out.push(...renderReasoning(c.reasoning, ctx));
  out.push(...renderToolUses(c.toolUses, ctx));
  const body = renderAssistantText(c.text, ctx);
  if (body) out.push(body);
  return out.join('\n\n');
}

function collectToolNames(conv) {
  const names = new Set();
  const addFrom = list => { for (const tu of list || []) if (tu?.name) names.add(tu.name); };
  for (const m of conv.messages || []) {
    const c = m.content;
    if (!c || typeof c !== 'object') continue;
    addFrom(c.toolUses);
    for (const step of c.taskRun || []) {
      addFrom(step.toolUses);
      for (const sub of step.subtasks || []) addFrom(sub.toolUses);
    }
  }
  return [...names].sort();
}

/**
 * Render a conversation as an Obsidian note.
 * @param {object} conv  stored conversation ({ id, title, messages, pinned, session, tokenCount, createdAt, updatedAt })
 * @param {object} opts  { includeTools=true, includeReasoning=false, model='', timeZone, availableFiles: Set<string> }
 * @returns {{ markdown: string, sidecars: Array<{kind, name, content?, base64?}>, fileRefs: string[] }}
 */
export function renderNote(conv, opts = {}) {
  const ctx = {
    includeTools: opts.includeTools !== false,
    includeReasoning: opts.includeReasoning === true,
    timeZone: opts.timeZone,
    availableFiles: opts.availableFiles instanceof Set ? opts.availableFiles : new Set(opts.availableFiles || []),
    base: noteBaseName(conv),
    sidecars: [],
  };
  const messages = (conv.messages || []).filter(m => !(m.role === 'user' && m.hidden));
  const tools = collectToolNames(conv);
  const session = conv.session && /^[a-z]{1,16}$/.test(conv.session) ? conv.session : '';
  const tags = ['lumispec', ...(session ? [`lumispec/${session}`] : [])];

  const fm = [
    '---',
    `title: ${yamlStr(conv.title)}`,
    `lumispec_id: ${yamlStr(conv.id)}`,
    `created: ${yamlStr(conv.createdAt)}`,
    `updated: ${yamlStr(conv.updatedAt)}`,
    `session: ${yamlStr(session)}`,
    `pinned: ${conv.pinned ? 'true' : 'false'}`,
    `model: ${yamlStr(opts.model || '')}`,
    `messages: ${messages.length}`,
    `tokens: ${Number(conv.tokenCount) || 0}`,
    `tools_used: ${yamlList(tools)}`,
    `tags: ${yamlList(tags)}`,
    '---',
  ].join('\n');

  const body = messages.map(m => (m.role === 'user' ? renderUser(m, ctx) : renderAssistant(m, ctx))).filter(Boolean);
  // No link back into the app: the note is a one-way artifact (see docs/OBSIDIAN.md).
  const footer = `---\nExported from Lumispec · ${conv.updatedAt || ''}`;
  const markdown = [fm, `# ${String(conv.title || 'Untitled').trim()}`, ...body, footer].join('\n\n') + '\n';
  return { markdown, sidecars: ctx.sidecars, fileRefs: [...ctx.availableFiles] };
}

// ── Vault I/O ───────────────────────────────────────

/** Attachment folder per the vault's own setting (.obsidian/app.json → attachmentFolderPath). */
export function attachmentDir(vault, folder, noteDir, { readText = p => readFileSync(p, 'utf-8') } = {}) {
  let setting;
  try { setting = JSON.parse(readText(join(vault, '.obsidian', 'app.json')))?.attachmentFolderPath; } catch { /* no setting */ }
  if (typeof setting !== 'string' || !setting.trim()) return join(vault, folder, 'attachments');
  const s = setting.trim();
  if (s === '/' || s === '.') return s === '/' ? vault : noteDir;
  if (s.startsWith('./')) return join(noteDir, s.slice(2));
  return join(vault, s.replace(/^\/+/, ''));
}

/** All /files/<name> names referenced in the conversation text that exist under SOURCE_DIR. */
function findAvailableFiles(conv, sourceDir) {
  const names = new Set();
  if (!sourceDir) return names;
  const scan = text => {
    for (const m of String(text || '').matchAll(/\/files\/([^)\s"'<>]+)/g)) {
      const name = decodeURIComponent(m[1].split('?')[0]);
      if (!name || name.includes('..') || name.includes('/')) continue;
      names.add(name);
    }
  };
  for (const m of conv.messages || []) {
    const c = m.content;
    if (typeof c === 'string') scan(c);
    else if (c && typeof c === 'object') {
      scan(c.text);
      for (const step of c.taskRun || []) { scan(step.result); for (const sub of step.subtasks || []) scan(sub.result); }
      for (const tu of c.toolUses || []) { const p = parseResult(tu.result); if (p?._autoSaved && p.savedFile?.filename) names.add(p.savedFile.filename); }
    }
  }
  const present = new Set();
  for (const n of names) { try { if (statSync(join(sourceDir, n)).isFile()) present.add(n); } catch { /* skip */ } }
  return present;
}

function assertInside(root, target) {
  const r = resolve(root), t = resolve(target);
  if (t !== r && !t.startsWith(r + sep)) throw new Error(`refusing to write outside the vault: ${t}`);
  return t;
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/**
 * Find an earlier note for this conversation — any `*-<id8>.md` under the export folder or one
 * of its colour subfolders — and rename it to `target`. Covers title changes (new slug) and
 * colour changes (new subfolder). Nothing is deleted; Obsidian updates links on rename.
 */
function moveStaleNote(vault, folderAbs, target, conv) {
  const suffix = `-${String(conv.id).slice(0, 8)}.md`;
  const candidates = [];
  const scanDir = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isFile() && e.name.endsWith(suffix)) candidates.push(join(dir, e.name));
  };
  scanDir(folderAbs);
  try {
    for (const e of readdirSync(folderAbs, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'attachments' && e.name !== 'wiki') scanDir(join(folderAbs, e.name));
    }
  } catch { /* folder does not exist yet */ }
  const stale = candidates.find(p => resolve(p) !== resolve(target));
  if (!stale) return null;
  assertInside(vault, stale);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(stale, target);
  return stale;
}

/**
 * Write the note (and its sidecars / copied data files) for `conv` into the vault.
 * @returns {{ path, moved?: string, attachments: string[] }}
 */
export function exportConversation(conv, cfg = {}, { vault = null, sourceDir = config.sourceDir, model = '', envVault } = {}) {
  const v = vault || resolveVault(cfg, envVault !== undefined ? { envVault } : {});
  if (!v) throw new Error('no vault configured');
  const folder = String(cfg.folder || 'Lumispec').replace(/^\/+|\/+$/g, '') || 'Lumispec';
  const folderAbs = assertInside(v.path, join(v.path, folder));
  const target = assertInside(folderAbs, join(folderAbs, noteRelPath(conv)));
  const availableFiles = findAvailableFiles(conv, sourceDir);
  const { markdown, sidecars } = renderNote(conv, {
    includeTools: cfg.includeTools !== false,
    includeReasoning: cfg.includeReasoning === true,
    model, availableFiles,
  });

  const moved = moveStaleNote(v.path, folderAbs, target, conv);
  const attDir = assertInside(v.path, attachmentDir(v.path, folder, dirname(target)));
  const attachments = [];
  for (const sc of sidecars) {
    const p = assertInside(v.path, join(attDir, sc.name));
    writeAtomic(p, sc.base64 ? Buffer.from(sc.base64, 'base64') : sc.content);
    attachments.push(p);
  }
  for (const name of availableFiles) {
    const src = join(sourceDir, name);
    const dst = assertInside(v.path, join(attDir, name));
    try {
      const s = statSync(src), d = existsSync(dst) ? statSync(dst) : null;
      if (!d || d.size !== s.size || d.mtimeMs < s.mtimeMs) { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); }
      attachments.push(dst);
    } catch (e) { console.warn(`[obsidian] could not copy ${name}: ${e.message}`); }
  }
  writeAtomic(target, markdown);
  return { path: target, moved: moved || undefined, attachments };
}

// ── Model name (frontmatter) ────────────────────────

let modelCache = { at: 0, name: '' };
/** Best-effort model label: Claude model id, or llama-server's alias from /props (cached 60 s). */
export async function getModelName() {
  if (config.llm?.backend === 'claude') return config.claude?.model || 'claude';
  if (Date.now() - modelCache.at < 60_000) return modelCache.name;
  let name = '';
  try {
    const res = await fetch(`${config.llama.baseUrl}/props`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const j = await res.json();
      name = j.model_alias || (j.model_path ? basename(j.model_path, extname(j.model_path)) : '') || '';
    }
  } catch { /* llama-server down: leave empty */ }
  modelCache = { at: Date.now(), name };
  return name;
}

export default { registryPaths, findVaults, resolveVault, renderNote, exportConversation, attachmentDir, noteRelPath, slugify, getModelName };
