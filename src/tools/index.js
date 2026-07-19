import { mkdir, appendFile, readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { readdir } from 'fs/promises';
import config from '../config.js';

import { fileURLToPath } from 'url';
const __dirname = import.meta.dirname || (() => { const f = fileURLToPath(import.meta.url); return f.substring(0, f.lastIndexOf('/')); })();
const LOG_DIR = resolve(__dirname, '../../logs');
const PLUGIN_CONFIG_PATH = resolve(__dirname, '../../data/plugins.json');

// ── Shared helpers (exported for plugins) ────────────────

export function fixPythonBooleans(code) {
  code = code.replace(/(\w\s*=\s*)true\b/g, '$1True')
             .replace(/(\w\s*=\s*)false\b/g, '$1False')
             .replace(/(\w\s*=\s*)null\b/g, '$1None');
  code = code.replace(/\bwhile true\b/g, 'while True')
             .replace(/\bwhile false\b/g, 'while False')
             .replace(/\bif true\b/g, 'if True')
             .replace(/\bif false\b/g, 'if False')
             .replace(/\breturn true\b/g, 'return True')
             .replace(/\breturn false\b/g, 'return False')
             .replace(/\bnull\b/g, 'None');
  return code;
}

export function tagLineCount(stdout, limit) {
  const out = (stdout || '').slice(0, limit);
  const lines = out.split('\n').filter(Boolean);
  return lines.length > 3 ? out + `\n[${lines.length} lines total]` : out;
}

// ── Cite mode helpers ───────────────────────────────────
//
// These three helpers implement the mechanical pieces of Cite mode (see
// docs/KNOWLEDGE_HARDENING.md). They are deterministic, no LLM calls, no
// network — they just look at strings and the filesystem.
//
// extractAddedLines parses a unified diff and returns the lines that were
// added (not context, not removed), with their resulting line numbers in
// the new file. Used by the diff-preview claim highlighter.
//
// detectUncitedClaims runs a small set of narrow regex patterns over a
// list of added lines and reports lines that look like architectural
// claims but lack a nearby (file:line) or `file:line` citation. Soft
// signal — produces warnings, never refuses anything.
//
// validateCitations parses any text for (file:line) / `file:line`
// citation patterns and checks each one against the filesystem under
// sourceRoot. Citations whose path doesn't exist or whose line number
// exceeds the file length are reported as broken. Hard signal — used by
// wiki_index in cite mode to refuse-write entries with broken citations.

const CITE_CITATION_RE = /[`(]([\w./_-]+\.(?:js|mjs|cjs|ts|jsx|tsx|py|md|markdown|json|sh|yaml|yml|toml|css|html|env|example)):(\d+)(?:[-:](\d+))?[`)]/;
const CITE_CITATION_RE_GLOBAL = new RegExp(CITE_CITATION_RE.source, 'g');

// Narrow claim patterns. Intentionally conservative — better to miss a
// subtle claim than to spam false positives that train users to ignore
// the highlighter. If you add a pattern here, prefer one that has near-
// zero false-positive rate on plain prose like README sentences.
const CITE_CLAIM_PATTERNS = [
  // Project-relative file path mentions followed within ~80 chars by a
  // behavioral verb. Catches "src/foo.js handles requests" without a cite.
  /\b(?:src|docs|data|releases|wiki)\/[\w./-]+(?:\.[a-z]+)?\b[\s\S]{0,80}?\b(?:provides|implements|executes|returns|throws|calls|handles|stores|reads|writes|fires|emits|listens|registers|manages|injects|hooks|wraps|owns)\b/i,
  // Backtick-quoted identifier (function name, class name, constant) followed
  // by an implementation verb within ~50 chars. Catches "`doFoo()` returns
  // null when called" without a cite.
  /`[A-Za-z_][\w]*(?:\(\))?`[\s\S]{0,50}?\b(?:is implemented|implements|provides|executes|returns|throws|calls|handles|fires|emits|wraps|owns)\b/i,
  // Numerical claim with a unit. Catches "32K cap on previous results"
  // without a cite. The unit set is deliberately narrow.
  /\b\d+\s*(?:K|MB|GB|seconds?|chars?|tokens?|rounds?|lines?|files?)\b/i,
];

export function extractAddedLines(diff) {
  if (!diff || typeof diff !== 'string') return [];
  const out = [];
  let lineNum = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      // Parse @@ -old,oldCount +new,newCount @@ — the +newStart is what
      // we track for the resulting file.
      const m = line.match(/\+(\d+)(?:,\d+)?/);
      if (m) lineNum = parseInt(m[1], 10);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      out.push({ lineNum, text: line.slice(1) });
      lineNum++;
    } else if (line.startsWith(' ')) {
      lineNum++;
    }
    // '-' lines do not advance the new-file line counter.
  }
  return out;
}

export function detectUncitedClaims(addedLines) {
  if (!Array.isArray(addedLines)) return [];
  const warnings = [];
  for (const { lineNum, text } of addedLines) {
    if (!text || text.trim().length < 20) continue;
    // If the line itself contains a citation, it's already grounded.
    if (CITE_CITATION_RE.test(text)) continue;
    for (const pattern of CITE_CLAIM_PATTERNS) {
      if (pattern.test(text)) {
        warnings.push({
          line: lineNum,
          snippet: text.length > 100 ? text.slice(0, 100) + '…' : text,
          reason: 'claim-shaped sentence without nearby (file:line) citation',
        });
        break; // one warning per line
      }
    }
  }
  return warnings;
}

export async function validateCitations(text, sourceRoot) {
  if (!text || !sourceRoot) return [];
  const broken = [];
  const seen = new Set();
  const { stat: fsStat, readFile: fsReadFile } = await import('fs/promises');
  const { resolve: resolvePath } = await import('path');
  const root = resolvePath(sourceRoot);
  let m;
  // Reset the global regex's lastIndex so repeated calls don't get stuck.
  CITE_CITATION_RE_GLOBAL.lastIndex = 0;
  while ((m = CITE_CITATION_RE_GLOBAL.exec(text)) !== null) {
    const [, relPath, lineStr] = m;
    const sig = `${relPath}:${lineStr}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    const abs = resolvePath(root, relPath);
    if (!abs.startsWith(root)) {
      broken.push({ citation: sig, reason: 'path escapes source root' });
      continue;
    }
    try {
      const s = await fsStat(abs);
      if (!s.isFile()) {
        broken.push({ citation: sig, reason: 'not a file' });
        continue;
      }
      const content = await fsReadFile(abs, 'utf-8');
      const totalLines = content.split('\n').length;
      const line = parseInt(lineStr, 10);
      if (line < 1 || line > totalLines) {
        broken.push({ citation: sig, reason: `line ${line} outside file (file has ${totalLines} lines)` });
      }
    } catch {
      broken.push({ citation: sig, reason: 'path does not exist' });
    }
  }
  return broken;
}

// ── Tool call logger ────────────────────────────────
export async function logToolCall(toolName, action, { args, rawResult, formattedResult }) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const now = new Date();
    const ts = now.toISOString();
    const logFile = join(LOG_DIR, `tools_${now.toISOString().split('T')[0]}.log`);
    const line = `\n${'═'.repeat(80)}\n[${ts}] ${toolName}:${action}\n${'─'.repeat(80)}\nARGS: ${JSON.stringify(args)}\n─── RAW ───\n${JSON.stringify(rawResult, null, 2)}\n─── FORMATTED (to LLM) ───\n${JSON.stringify(formattedResult, null, 2)}\n`;
    await appendFile(logFile, line, 'utf-8');
  } catch (err) {
    console.warn(`[logToolCall] failed: ${err.message}`);
  }
}

// ── Plugin registry ─────────────────────────────────
const tools = {};        // name → { description, parameters, execute }
const toolGroups = {};   // groupName → { tools, condition, routing, prompt, status }
const pluginModules = {}; // groupName → { file, plugin } (cached for hot reload)
const pluginDependencies = {}; // groupName → string[] of declared dependency group names

// Groups that are always loaded and not shown in the config UI
const ALWAYS_ON_GROUPS = new Set(['core', 'execution']);

// ── Plugin dependency graph ─────────────────────────

// Validate the dependency graph after all plugin modules are imported.
// - Populates pluginDependencies from each plugin's `dependencies` field
// - Warns on missing dependencies (declared but no such plugin module exists)
// - Detects circular dependencies via DFS three-coloring; logs error if found
// Returns array of cycle paths for diagnostics.
function validateDependencyGraph() {
  // Collect declarations
  for (const [group, { plugin }] of Object.entries(pluginModules)) {
    pluginDependencies[group] = Array.isArray(plugin.dependencies)
      ? [...new Set(plugin.dependencies)]
      : [];
  }

  // Warn on missing deps
  for (const [group, deps] of Object.entries(pluginDependencies)) {
    for (const dep of deps) {
      if (ALWAYS_ON_GROUPS.has(dep)) continue; // always satisfied
      if (!pluginModules[dep]) {
        console.warn(`[plugins] "${group}" declares missing dependency "${dep}" — cascade will skip it`);
      }
    }
  }

  // Cycle detection via DFS three-coloring
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const colors = {};
  for (const g of Object.keys(pluginDependencies)) colors[g] = WHITE;
  const cycles = [];
  function dfs(group, path) {
    colors[group] = GRAY;
    for (const dep of pluginDependencies[group] || []) {
      if (ALWAYS_ON_GROUPS.has(dep)) continue;
      if (!pluginModules[dep]) continue;
      if (colors[dep] === GRAY) {
        cycles.push([...path, group, dep]);
        continue;
      }
      if (colors[dep] === WHITE) dfs(dep, [...path, group]);
    }
    colors[group] = BLACK;
  }
  for (const g of Object.keys(pluginDependencies)) {
    if (colors[g] === WHITE) dfs(g, []);
  }
  if (cycles.length > 0) {
    for (const cycle of cycles) {
      console.error(`[plugins] CIRCULAR DEPENDENCY: ${cycle.join(' -> ')}`);
    }
  }
  return cycles;
}

// Returns the transitive set of groups that must be enabled when GROUP is enabled,
// including GROUP itself. Cycle-safe via visited set.
function getCascadeEnableSet(group, visited = new Set()) {
  if (visited.has(group)) return [];
  visited.add(group);
  const out = new Set([group]);
  for (const dep of pluginDependencies[group] || []) {
    if (ALWAYS_ON_GROUPS.has(dep)) continue;
    if (!pluginModules[dep]) continue;
    out.add(dep);
    for (const t of getCascadeEnableSet(dep, visited)) out.add(t);
  }
  return [...out];
}

// Returns immediate dependents of GROUP (groups that declare GROUP in their dependencies).
function getDirectDependents(group) {
  const out = [];
  for (const [g, deps] of Object.entries(pluginDependencies)) {
    if (deps.includes(group)) out.push(g);
  }
  return out;
}

// Returns all transitive dependents of GROUP (groups that would break if GROUP went away).
function getAllDependents(group, visited = new Set()) {
  if (visited.has(group)) return [];
  visited.add(group);
  const out = new Set();
  for (const direct of getDirectDependents(group)) {
    out.add(direct);
    for (const t of getAllDependents(direct, visited)) out.add(t);
  }
  return [...out];
}

// Returns the subset of GROUP's transitive dependents that are CURRENTLY enabled.
// Used to block disable: if any dependent is currently registered, the disable is refused.
function getEnabledDependents(group) {
  return getAllDependents(group).filter(g => !!toolGroups[g]);
}

export async function readPluginConfig() {
  try {
    const raw = await readFile(PLUGIN_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    // Normalize legacy boolean values → { enabled: bool }
    for (const [key, val] of Object.entries(cfg)) {
      if (typeof val === 'boolean') cfg[key] = { enabled: val };
    }
    return cfg;
  } catch {
    return {};
  }
}

function getPluginDefaults(group) {
  return pluginModules[group]?.plugin?.defaults || { enabled: true };
}

async function writePluginConfig(cfg) {
  await writeFile(PLUGIN_CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
}

function registerPlugin(plugin) {
  const toolNames = [];
  for (const [name, def] of Object.entries(plugin.tools)) {
    tools[name] = def;
    toolNames.push(name);
  }
  toolGroups[plugin.group] = {
    tools: toolNames,
    condition: plugin.condition || undefined,
    routing: plugin.routing || [],
    prompt: plugin.prompt || null,
    status: plugin.status || null,
  };
  console.log(`[tools] Loaded plugin "${plugin.group}" with tools: ${toolNames.join(', ')}`);
}

function unregisterPlugin(groupName) {
  const group = toolGroups[groupName];
  if (!group) return;
  for (const name of group.tools) {
    delete tools[name];
    disabledTools.delete(name);
  }
  delete toolGroups[groupName];
  console.log(`[tools] Unloaded plugin "${groupName}"`);
}

export async function loadPlugins() {
  const files = await readdir(__dirname);
  const pluginFiles = files.filter(f => f.startsWith('plugin-') && f.endsWith('.js')).sort();
  const cfg = await readPluginConfig();

  // Pass 1: import all plugin modules and cache them (no registration yet)
  for (const file of pluginFiles) {
    const mod = await import(join(__dirname, file));
    const plugin = mod.default;
    if (!plugin?.group || !plugin?.tools) {
      console.warn(`[tools] Skipping ${file}: missing group or tools`);
      continue;
    }
    pluginModules[plugin.group] = { file, plugin };
  }

  // Pass 2: validate the dependency graph (warn on missing, error on cycles)
  validateDependencyGraph();

  // Pass 3: compute the closure of enabled groups by cascading dependencies,
  // persist any cascade-induced changes, then register everything in the closure.
  const enabledClosure = new Set();
  for (const group of Object.keys(pluginModules)) {
    if (ALWAYS_ON_GROUPS.has(group)) continue;
    // Default-enabled unless cfg explicitly disables
    if (cfg[group]?.enabled !== false) {
      for (const g of getCascadeEnableSet(group)) {
        if (!ALWAYS_ON_GROUPS.has(g) && pluginModules[g]) enabledClosure.add(g);
      }
    }
  }

  let cfgChanged = false;
  for (const group of enabledClosure) {
    if (cfg[group]?.enabled === false || !cfg[group]) {
      const defaults = pluginModules[group].plugin.defaults || { enabled: true };
      const wasDisabled = cfg[group]?.enabled === false;
      cfg[group] = { ...(cfg[group] || defaults), enabled: true };
      cfgChanged = true;
      if (wasDisabled) {
        console.log(`[plugins] startup cascade: enabling "${group}" (required by another enabled plugin)`);
      }
    }
  }
  if (cfgChanged) await writePluginConfig(cfg);

  // Now register: always-on first, then everything in the enabled closure
  for (const group of Object.keys(pluginModules)) {
    if (ALWAYS_ON_GROUPS.has(group)) {
      registerPlugin(pluginModules[group].plugin);
      continue;
    }
    if (enabledClosure.has(group)) {
      registerPlugin(pluginModules[group].plugin);
    } else {
      console.log(`[tools] Plugin "${group}" disabled by config — skipped`);
    }
  }
}

// ── Plugin config API ──────────────────────────────
export async function listPluginGroups() {
  const cfg = await readPluginConfig();
  return Object.entries(pluginModules)
    .filter(([group]) => !ALWAYS_ON_GROUPS.has(group))
    .map(([group, { plugin }]) => {
      // Filter dependency lists to user-visible groups (skip always-on and missing)
      const visibleDeps = (pluginDependencies[group] || []).filter(
        d => !ALWAYS_ON_GROUPS.has(d) && pluginModules[d]
      );
      const visibleDependents = getDirectDependents(group).filter(
        d => !ALWAYS_ON_GROUPS.has(d) && pluginModules[d]
      );
      const entry = {
        group,
        label: plugin.label || group.charAt(0).toUpperCase() + group.slice(1),
        description: plugin.description || '',
        enabled: !!toolGroups[group],
        dependencies: visibleDeps,
        dependents: visibleDependents,
        tools: Object.entries(plugin.tools).map(([name, def]) => ({
          name,
          description: def.description.split('\n')[0],
        })),
      };
      // Include per-plugin config if plugin defines defaults
      if (plugin.defaults) {
        const defaults = plugin.defaults;
        const saved = cfg[group] || {};
        entry.config = { ...defaults, ...saved };
        delete entry.config.enabled; // enabled is already top-level
        // For web plugin, include available engines info
        if (group === 'web') {
          entry.config.modes = ['regular', 'stealth', 'browser'];
          entry.config.availableEngines = [
            { id: 'tavily', label: 'Tavily', available: !!config.tavily.apiKey },
            { id: 'keiro', label: 'Keiro', available: !!config.keiro.apiKey },
            { id: 'duckduckgo', label: 'DuckDuckGo', available: true },
          ];
        }
      }
      return entry;
    });
}

export async function updatePluginConfig(groupName, updates) {
  if (ALWAYS_ON_GROUPS.has(groupName)) return { error: 'Cannot toggle always-on plugins' };
  const cached = pluginModules[groupName];
  if (!cached) return { error: `Unknown plugin: ${groupName}` };

  const cfg = await readPluginConfig();

  // Cascade enable: ensure all transitive dependencies are enabled before this plugin
  const cascadedOn = [];
  if (updates.enabled === true) {
    for (const dep of getCascadeEnableSet(groupName)) {
      if (dep === groupName) continue;
      if (ALWAYS_ON_GROUPS.has(dep)) continue;
      const depCached = pluginModules[dep];
      if (!depCached) continue;
      const depDefaults = depCached.plugin.defaults || { enabled: true };
      const depCfg = cfg[dep] || { ...depDefaults };
      const wasOff = !toolGroups[dep] || depCfg.enabled === false;
      if (wasOff) {
        depCfg.enabled = true;
        cfg[dep] = depCfg;
        if (!toolGroups[dep]) registerPlugin(depCached.plugin);
        cascadedOn.push(dep);
        console.log(`[plugins] cascade: enabled "${dep}" (required by "${groupName}")`);
      }
    }
  }

  // Cascade disable: also disable all transitive enabled dependents.
  // This is the inverse of cascade-enable. Disclosed via cascadedOff in the response
  // so the UI can surface what was disabled.
  const cascadedOff = [];
  if (updates.enabled === false) {
    for (const dep of getEnabledDependents(groupName)) {
      const depCached = pluginModules[dep];
      if (!depCached) continue;
      const depDefaults = depCached.plugin.defaults || { enabled: true };
      const depCfg = cfg[dep] || { ...depDefaults };
      depCfg.enabled = false;
      cfg[dep] = depCfg;
      if (toolGroups[dep]) unregisterPlugin(dep);
      cascadedOff.push(dep);
      console.log(`[plugins] cascade: disabled "${dep}" (depended on "${groupName}")`);
    }
  }

  const defaults = cached.plugin.defaults || { enabled: true };
  const current = cfg[groupName] || { ...defaults };

  // Merge updates for the target plugin
  if (updates.enabled !== undefined) current.enabled = updates.enabled;
  if (updates.mode !== undefined) current.mode = updates.mode;
  if (updates.engines !== undefined) current.engines = updates.engines;

  // Hot-load / hot-unload based on enabled state
  if (current.enabled && !toolGroups[groupName]) {
    registerPlugin(cached.plugin);
  } else if (!current.enabled && toolGroups[groupName]) {
    unregisterPlugin(groupName);
  }

  cfg[groupName] = current;
  await writePluginConfig(cfg);

  const result = { group: groupName, enabled: !!toolGroups[groupName], config: current };
  if (cascadedOn.length > 0) result.cascadedOn = cascadedOn;
  if (cascadedOff.length > 0) result.cascadedOff = cascadedOff;
  return result;
}

// Backward compat wrapper
export async function setPluginEnabled(groupName, enabled) {
  return updatePluginConfig(groupName, { enabled });
}

// ── Command confirmation (queue-based for parallel tool calls) ──
const pendingConfirmations = new Map();
const CONFIRMATION_TIMEOUT_MS = 120000;

export function requestConfirmation(conversationId, command) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const queue = pendingConfirmations.get(conversationId);
      if (queue) {
        const idx = queue.findIndex(e => e.command === command && e.resolve === resolve);
        if (idx !== -1) {
          console.warn(`[confirm] timeout after ${CONFIRMATION_TIMEOUT_MS / 1000}s for conversation ${conversationId}`);
          queue.splice(idx, 1);
          if (queue.length === 0) pendingConfirmations.delete(conversationId);
          resolve(false);
        }
      }
    }, CONFIRMATION_TIMEOUT_MS);
    if (!pendingConfirmations.has(conversationId)) pendingConfirmations.set(conversationId, []);
    pendingConfirmations.get(conversationId).push({ resolve, command, timer });
  });
}

export function resolveConfirmation(conversationId, approved) {
  const queue = pendingConfirmations.get(conversationId);
  if (!queue || queue.length === 0) return false;
  const entry = queue.shift();
  clearTimeout(entry.timer);
  if (queue.length === 0) pendingConfirmations.delete(conversationId);
  entry.resolve(approved);
  return true;
}

export function cancelConfirmation(conversationId) {
  const queue = pendingConfirmations.get(conversationId);
  if (!queue || queue.length === 0) return false;
  console.warn(`[confirm] cancelled ${queue.length} pending confirmation(s) for conversation ${conversationId}`);
  for (const entry of queue) {
    clearTimeout(entry.timer);
    entry.resolve(false);
  }
  pendingConfirmations.delete(conversationId);
  return true;
}

// ── Tool enable/disable state ───────────────────────
const disabledTools = new Set();

export function listTools() {
  return Object.entries(tools).map(([name, t]) => ({
    name,
    description: t.description.split('\n')[0],
    parameters: Object.keys(t.parameters),
    enabled: !disabledTools.has(name),
  }));
}

export function setToolEnabled(name, enabled) {
  if (!tools[name]) return false;
  if (enabled) disabledTools.delete(name);
  else disabledTools.add(name);
  return true;
}

// ── Tool group helpers ──────────────────────────────
function isGroupEnabled(group) {
  const hasEnabledTool = group.tools.some(t => !disabledTools.has(t));
  const conditionMet = !group.condition || group.condition();
  return hasEnabledTool && conditionMet;
}

export function isToolGroupEnabled(groupName) {
  return toolGroups[groupName] ? isGroupEnabled(toolGroups[groupName]) : false;
}

// ── Plugin status helpers ───────────────────────────
export async function getPluginStatuses() {
  const results = [];
  for (const [group, g] of Object.entries(toolGroups)) {
    if (!g.status) continue;
    const managed = g.status.managed !== false;
    try {
      const state = managed && g.status.poll ? await g.status.poll() : null;
      results.push({
        group,
        label: g.status.label,
        state,
        interval: g.status.interval ?? 0,
        hasAuth: !!g.status.auth,
        managed,
      });
    } catch {
      results.push({
        group,
        label: g.status.label,
        state: 'error',
        interval: g.status.interval ?? 0,
        hasAuth: !!g.status.auth,
        managed,
      });
    }
  }
  return results;
}

export function getPluginAuth(groupName) {
  return toolGroups[groupName]?.status?.auth || null;
}

// ── Taskmaster prompt (read from data/TASKMASTER.md) ──
const TASKMASTER_PATH = resolve(__dirname, '../../data/TASKMASTER.md');

export async function getTaskmasterPrompt() {
  return readFile(TASKMASTER_PATH, 'utf-8');
}

// ── Precision Mode rules (standalone, not tied to any plugin) ──
const PRECISION_RULES = `## Precision Mode — Computation Discipline
- NEVER do mental math, manual arithmetic, or approximate calculations. For ANY computation involving more than 3 numbers, aggregations (sum, avg, count, group-by), data with more than 10 rows, date math, filtering/sorting, or any question where getting the wrong number would be harmful — use run_python.
- NEVER round, abbreviate, reformat, or manually transcribe numerical data. Present values EXACTLY as they appear in tool results. Dropping digits, misplacing decimals, or rounding amounts is a serious error (e.g. $92,891.35 must stay $92,891.35 — never $924.83, $92,891, or $92.9K).
- NEVER fabricate, interpolate, or invent figures. Only present values that appear verbatim in tool results or Python output. If a field or row doesn't exist in the data, don't create it.
- NEVER substitute training-data knowledge for missing data. If a tool call didn't return the data you need, RETRY with correct parameters or tell the user what's missing. NEVER say "the tool didn't return X, but here's what typically happens."
- WHEN TO USE run_python vs direct answer: USE run_python for: calculations with more than 3 numbers, aggregations, data with 10+ rows, date math, filtering/sorting, or anything where precision matters. ANSWER DIRECTLY for: single value lookups, qualitative questions, comparing 2-3 values, or explaining what data means. RULE OF THUMB: if you need to count, sum, or iterate — use Python.
- run_python code quality — MANDATORY rules:
  1. FORBIDDEN: iterrows(), itertuples(), for-loops over DataFrame rows, iloc[0] inside loops. Use ONLY vectorized pandas: groupby().agg(), merge(), df[condition]['col'].sum().
  2. Keep scripts under 40 lines. One task per script.
  3. Pick ONE output: print() a short summary OR save a file. Not both.
  4. Before submitting: mentally verify every string literal, bracket, quote, and f-string brace. A syntax error wastes an entire tool round.
- run_python error handling: If a script fails, DO NOT retry with the same approach. First run a small diagnostic script (e.g. print columns, print dtypes, print first row) to understand the data, then fix the actual issue. Maximum 1 retry after diagnosis.
- Large result sets (30+ rows) are auto-saved to CSV in the project directory. When you see "_autoSaved", use that filename directly in run_python.
- run_python runs in the source project directory — same location as saved files. Use filenames directly (e.g. pd.read_csv('data.csv')).`;

// ── Cite Mode rules (standalone, not tied to any plugin) ──
// See docs/KNOWLEDGE_HARDENING.md for the design rationale and the
// failure case (TaskMaster hallucination incident) that motivated it.
const CITE_RULES = `## Cite Mode — Code-Citation Discipline
Cite mode is active. The following discipline applies for the rest of this conversation:

1. **Markdown documentation writes** — When writing or editing any \`.md\` file via source_write or source_edit, every architectural claim — "X provides Y", "X is implemented as Z", "When X happens, Y", file paths, function names, parameter names, default values, behaviors — MUST be backed by a \`(src/path/file.js:LINE)\` citation pointing to the code that backs it up.

2. **Read before drafting** — Before writing a doc claim, use source_read read or source_read grep to find the actual code. Draft the doc with citations inline as you go. If you cannot cite a claim, do NOT write it — mark the gap as \`TODO: needs verification\` instead.

3. **Code claims in chat answers** — The same rule applies to architectural claims in chat answers. Quote line numbers, not memory. If asked about behavior you have not read, read it first via source_read.

4. **No training-data inference** — Do NOT claim that this codebase has a feature, library, file, or behavior that you know about from general LLM training data. The only source of truth is files you have read with source_read in this conversation.

5. **Refuse to fabricate** — If you are tempted to write a claim you cannot cite, write "I haven't checked this — let me read [file] first" and call source_read instead. Confident-sounding prose about a system you have not read is a critical trust violation.

This discipline guards against documentation hallucination — the failure mode where LLM-authored docs contain confident, fluent claims about architecture that does not exist in the code. The wiki indexer and the diff preview will run mechanical checks on your output and flag uncited claims; broken citations in wiki entries are refused.`;

// ── System prompt assembly ──────────────────────────
export function getSystemPrompt({ applets = false, precision = false, cite = false } = {}) {
  const toolList = Object.entries(tools)
    .filter(([name]) => !disabledTools.has(name))
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');

  const now = new Date();
  const datetime = {
    utc: now.toISOString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: now.getTimezoneOffset(),
  };

  // Inject precision rules if toggle is on OR finance group is active
  const precisionActive = precision || isToolGroupEnabled('finance');
  const precisionSection = precisionActive ? PRECISION_RULES : '';

  // Inject cite-mode rules when the toggle is on. The frontend defaults
  // the toggle to on when the source plugin is active, so this is the
  // common path for any conversation that can read code.
  const citeSection = cite ? CITE_RULES : '';

  const groupSections = Object.values(toolGroups)
    .filter(isGroupEnabled)
    .map(g => g.prompt)
    .filter(Boolean)
    .join('\n\n');

  const routingLines = Object.values(toolGroups)
    .filter(isGroupEnabled)
    .map(g => g.routing)
    .filter(Boolean)
    .flat()
    .filter(Boolean);

  // Cross-group warnings (only when both groups are active)
  if (toolGroups.finance && toolGroups.travel && isGroupEnabled(toolGroups.finance) && isGroupEnabled(toolGroups.travel)) {
    routingLines.push('- NEVER use etrade_account for travel/hotel queries. NEVER use hotel/travel for financial queries.');
  }

  const routingSection = routingLines.length
    ? `\n## Tool Routing — match user intent to the RIGHT tool\n${routingLines.join('\n')}`
    : '';

  return `You are a helpful, knowledgeable assistant.

## Core Behavior
Act, don't deliberate. Once you have the information needed to answer or produce output, do it IMMEDIATELY. Do NOT call additional tools to re-verify data you already have. One successful verification is enough — never check the same thing twice. If you have file paths, data, or results from a previous tool call, use them in your response right away.

## ABSOLUTE RULE: Never Fabricate Data
You MUST NEVER create, invent, or hardcode data that was not returned by a tool call. This is the #1 rule — it overrides all other instructions.
- If web_fetch fails (Cloudflare, login wall, timeout), use ONLY what appeared in web_search snippet text. Do not fill gaps.
- NEVER use run_python or source_write to create files containing invented data (fake showtimes, fake addresses, fake prices, "sample" or "placeholder" data). If the data didn't come from a tool result, you don't have it.
- When you lack data, tell the user plainly: "I could not retrieve [X] because [reason]. Here is what I did find: [actual data from tool results]."
- "Mock data", "sample data", "realistic placeholder" — these are all fabrication. Do not do this under any name.
- Presenting invented information as real is a critical trust violation. The user relies on you for facts.

## Current Date and Time
Today is ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. The current time is ${now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })} (${datetime.timezone}, UTC offset: ${datetime.offset >= 0 ? '-' : '+'}${Math.abs(datetime.offset / 60)}h). UTC: ${datetime.utc}.
Use this date when answering ANY question involving dates, time, age, deadlines, schedules, or "today/yesterday/tomorrow". Your training data may be outdated — for questions about current events, people in office, recent news, or anything time-sensitive, ALWAYS use web_search first before answering.
${config.location ? `\n## User Location\nThe user is located in ${config.location}. Use this as the default location for weather, travel, and location-based queries unless the user specifies a different location.` : ''}

## File Access
Project directory files (CSVs, data files) are served at \`/files/FILENAME\` — use this URL in applets to fetch saved data (e.g. \`fetch('/files/optionchains_123.csv')\`).
IMPORTANT: \`/files/\` is an HTTP URL for reading, NOT a filesystem path. To WRITE files, use the current working directory (e.g. \`open('data.json', 'w')\` in run_python) — they are automatically served at \`/files/data.json\`.
To display local images from anywhere on the filesystem, use the file proxy: \`/api/file?path=ABSOLUTE_PATH\`
Example: \`<img src="/api/file?path=/home/ols/Pictures/screenshot.png">\`

## Tool Call Format (MANDATORY — bare JSON without tags is SILENTLY DROPPED)

CRITICAL: Every tool call MUST be wrapped in <tool_call></tool_call> tags. Bare JSON without these tags will NOT execute — it will be displayed as plain text and the tool will never run.

WRONG (silently ignored — tool never runs):
{"name": "run_python", "arguments": {"code": "print('hello')"}}

CORRECT (this actually executes):
<tool_call>
{"name": "run_python", "arguments": {"code": "print('hello')"}}
</tool_call>

Multiple tool calls (executed in parallel):
<tool_call>
{"name": "web_search", "arguments": {"query": "latest news on AAPL"}}
</tool_call>
<tool_call>
{"name": "current_datetime", "arguments": {}}
</tool_call>

CRITICAL JSON rules:
- All arguments go FLAT in the "arguments" object. NEVER nest "arguments" inside "arguments".
- Every opening { must have a matching closing }.
- WRONG: {"name": "web_search", "arguments": {"query": "test", "arguments": {"maxResults": 5}}}
- RIGHT: {"name": "web_search", "arguments": {"query": "test", "maxResults": 5}}

Available tools:
${toolList}

Tool rules:
- Output ONLY <tool_call> blocks when using tools, no other text before or after.
- Wait for the tool result before answering.
- Be proactive: when the user asks for data, CALL the tool immediately with the right parameters. NEVER ask "would you like me to run this?" or "should I re-run with different parameters?" — just do it.
- REMINDER: tool calls without <tool_call> tags DO NOT EXECUTE.
${routingSection}

${precisionSection}

${citeSection}

${groupSections}

- NEVER claim you "fabricated" or "didn't actually call" a tool. Tool results in the conversation are real — they came from actual API calls. If you see a tool result, it happened.

## Response Formatting

Adapt formatting to response length:
- **Under 50 words**: Plain text, no special formatting needed.
- **50–150 words**: Use **bold** for key terms. Keep to 1–2 short paragraphs.
- **150–300 words**: Use ## headers to break into sections. Use bullet points where appropriate.
- **Over 300 words**: Begin with a **Key Takeaway** block (2–3 bullets). Use headers, lists, and tables.

Rules:
- Answer the question in the first sentence. Never bury the conclusion.
- Use **bold** for key terms only — never bold entire sentences.
- Use bullet points for 3+ related items. Use numbered lists only for sequential steps.
- Use tables for comparisons of 3+ items.
- Use fenced code blocks with language tags for code. Use \`inline code\` for technical terms.
- Mermaid v11 diagrams are supported by the UI (NOT a tool — just use fenced \`\`\`mermaid code blocks in your response). No emoji in Mermaid text. Pie chart labels MUST be quoted: \`"AMD" : 35.06\` (not \`AMD : 35.06\`). Pie values must be positive — if ANY value is negative, use xychart-beta bar chart instead. For ANY bar or line chart, the FIRST LINE must be exactly "xychart-beta" — no other chart type keyword exists (not "barChart", "lineChart", "line chart", "bar chart"). Use "bar" and "line" as series keywords inside xychart-beta. Valid types: pie, xychart-beta, flowchart, timeline, mindmap, gantt, journey, sequenceDiagram.
- Keep paragraphs to 2–4 sentences.
- Use emoji sparingly as section markers (e.g., 📌 Key Point, ⚠️ Warning) — never inline or decorative.
- Use plain, direct language. No filler phrases or sycophantic openers.
- Separate major topic shifts with a horizontal rule (---).

${applets ? `## Applet Visualizations

IMPORTANT: Applets are NOT tools. Do NOT wrap applets in <tool_call> tags. Applets go directly in your response text.
ALL visualizations MUST be inline <applet> blocks in your response — they render as interactive iframes directly in the chat.

TEMPLATES: When the user's message contains a saved HTML template (in a code block preceded by "Use this saved HTML applet template"), you MUST use that template as-is. Output it as an <applet> block. Only modify data file references (filenames in fetch calls, embedded arrays) and configuration values the user asked to change. Do NOT change the layout, CSS, column structure, or visual design. The template is the user's preferred design — respect it exactly.

When the user requests a visualization, chart, diagram, dashboard, or interactive widget:
- Output <applet type="TYPE">...</applet> directly in your response text (NEVER inside <tool_call> tags)
- TYPE must be one of: svg, chartjs, html
- All CSS inline in <style>, all JS inline in <script>
- For displaying local images: use the file proxy \`/api/file?path=ABSOLUTE_PATH\` as img src. Use type="html" (NOT type="svg"). Once you have the file path from a tool result, emit the applet immediately — do not re-verify. Example: \`<img src="/api/file?path=/home/user/photo.png">\`
- For datasets: embed data in a const at the top of <script>
- Dark theme: background #1a1a2e, text #e0e0e0, accent #4a9eff, secondary #7c3aed, success #10b981, warning #f59e0b, error #ef4444, surface #16213e, border #2a2a4a
- Responsive: use percentage widths, min/max constraints
- TABLES: Always wrap tables in a div with overflow-x:auto so wide tables (many columns) scroll horizontally. Use white-space:nowrap on table cells to prevent column squishing. Example: <div style="overflow-x:auto"><table>...</table></div>
- Max 50KB total HTML size
- For resize: window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*')

For type="svg" applets:
- Use inline SVG directly in the HTML body
- Use viewBox for scaling, no fixed pixel dimensions on the SVG element
- Text: fill="#e0e0e0", font-family: system-ui
- Lines/borders: stroke="#2a2a4a"
- Shapes: fill with the accent palette above
- For flowcharts: use rounded rects, arrows with markers, labels centered in shapes
- SVG is best for diagrams, flowcharts, and simple card layouts (1-2 values per card). For tabular data with 3+ columns, use type="html" with an HTML table instead — SVG cannot reliably handle multi-column text alignment
- Use a viewBox width of at least 800. Assume each character is ~10px wide at font-size 16. Keep at most 2 text values per row in SVG. Use text-anchor="end" for right-aligned numbers with x set to (container_right - 20px)

For type="chartjs" applets:
- Chart.js is available at /lib/chart.min.js — include via <script src="/lib/chart.min.js"></script>
- Create a <canvas id="chart"></canvas> in the body
- Instantiate with: new Chart(document.getElementById('chart'), config)
- Use dark theme defaults: grid color '#2a2a4a', tick color '#e0e0e0'
- Plugin.legend.labels.color = '#e0e0e0'

Example — complete working applet:
<applet type="chartjs">
<!DOCTYPE html>
<html><head>
<script src="/lib/chart.min.js"></script>
<style>body { margin: 0; padding: 16px; background: #1a1a2e; }</style>
</head><body>
<canvas id="chart"></canvas>
<script>
const DATA = [
  { label: 'AAPL', value: 42 },
  { label: 'MSFT', value: 31 },
  { label: 'GOOGL', value: 27 }
];
new Chart(document.getElementById('chart'), {
  type: 'bar',
  data: {
    labels: DATA.map(d => d.label),
    datasets: [{ label: 'Allocation %', data: DATA.map(d => d.value),
      backgroundColor: '#4a9eff', borderColor: '#4a9eff', borderWidth: 1 }]
  },
  options: {
    responsive: true,
    scales: { y: { ticks: { color: '#e0e0e0' }, grid: { color: '#2a2a4a' } },
              x: { ticks: { color: '#e0e0e0' }, grid: { color: '#2a2a4a' } } },
    plugins: { legend: { labels: { color: '#e0e0e0' } } }
  }
});
</script>
</body></html>
</applet>

For type="html" applets:
- Pure HTML/CSS/JS, no external libraries
- Use CSS grid or flexbox for layouts
- For tables: sticky headers, alternating row colors (#16213e / #1a1a2e), hover highlight #2a2a4a
- For interactive controls: style inputs/selects/buttons with the dark palette
- Canvas API is available for custom drawing and animation
- JAVASCRIPT SYNTAX: Use null (NOT None), true/false (NOT True/False). These are Python keywords that cause ReferenceError in JS.
- Data files saved to project directory are available via /files/FILENAME (e.g. fetch('/files/optionchains_123.csv'))
- APPLET DATA LOADING: When tool results produce CSV files (_autoSaved), load them DIRECTLY in the applet via fetch('/files/FILENAME.csv') and parse in JS. Do NOT use run_python to pre-process or convert CSVs — this wastes tool rounds and introduces column name/value case errors. The CSV is already in the right format. Parse it client-side with split/map.

` : ''}## FINAL REMINDER
All tool calls MUST use <tool_call></tool_call> tags. Bare JSON is silently ignored — the tool will NOT run.`;
}

// ── Tool call parsing ───────────────────────────────

function unescapeJsonString(s) {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"');
}

function repairToolCallJson(raw) {
  raw = raw.replace(/\s*\/>/g, '}').replace(/<\/[^>]+>/g, '');
  const quoteFixed = raw.replace(/:(\s*)([a-zA-Z_][a-zA-Z0-9_]*)"/g, ':$1"$2"');
  const nameMatch = quoteFixed.match(/"name"\s*:\s*"([^"]+)"/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  try {
    const parsed = JSON.parse(quoteFixed);
    if (parsed.name) {
      console.log(`[parseToolCalls] repaired JSON by fixing missing quotes for tool "${name}"`);
      return { name: parsed.name, arguments: parsed.arguments || {} };
    }
  } catch { /* continue to other repair attempts */ }

  // Attempt 1: smart-escape literal newlines/tabs/CR inside JSON string values
  try {
    let escaped = '';
    let esc_inStr = false;
    for (let j = 0; j < raw.length; j++) {
      const ch = raw[j];
      if (esc_inStr) {
        if (ch === '\\') { escaped += ch + (raw[++j] || ''); continue; }
        if (ch === '"') esc_inStr = false;
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          if (ch === '\n') { escaped += '\\n'; }
          else if (ch === '\r') { escaped += '\\r'; }
          else if (ch === '\t') { escaped += '\\t'; }
          else { escaped += '\\u' + code.toString(16).padStart(4, '0'); }
          continue;
        }
        escaped += ch;
      } else {
        if (ch === '"') esc_inStr = true;
        escaped += ch;
      }
    }
    const parsed = JSON.parse(escaped);
    if (parsed.name) {
      console.log(`[parseToolCalls] repaired JSON by smart-escaping newlines for tool "${name}"`);
      return { name: parsed.name, arguments: parsed.arguments || {} };
    }
  } catch { /* continue to next attempt */ }

  // Attempt 2: manually extract string arguments for tools with large content
  const toolArgMap = {
    run_python: { primary: 'code' },
    source_write: { primary: 'content', extra: ['path'] },
    source_edit: { primary: 'new_string', extra: ['path', 'old_string'] },
  };
  const argConfig = toolArgMap[name];
  if (argConfig) {
    const extractStringArg = (src, key) => {
      const pattern = new RegExp(`"${key}"\\s*:\\s*"`);
      const m = src.match(pattern);
      if (!m) return null;
      const start = m.index + m[0].length;
      let end = -1;
      for (let j = start; j < src.length; j++) {
        const ch = src[j];
        if (ch === '\\') { j++; continue; }
        if (ch.charCodeAt(0) < 0x20) continue;
        if (ch === '"') {
          const after = src.slice(j + 1).trimStart();
          if (after.startsWith('}') || after.match(/^,\s*"/)) {
            end = j; break;
          }
        }
      }
      if (end === -1) {
        end = src.length;
        while (end > start && /[\s}"}\]]/.test(src[end - 1])) end--;
      }
      return end > start ? unescapeJsonString(src.slice(start, end)) : null;
    };

    const primary = extractStringArg(raw, argConfig.primary);
    if (primary !== null) {
      const args = { [argConfig.primary]: primary };
      if (argConfig.extra) {
        for (const key of argConfig.extra) {
          const val = extractStringArg(raw, key);
          if (val !== null) args[key] = val;
        }
      }
      console.log(`[parseToolCalls] manually extracted args (${Object.keys(args).join(', ')}) for tool "${name}"`);
      return { name, arguments: args };
    }
  }

  return null;
}

export function parseToolCalls(text) {
  const calls = [];

  text = text.replace(/<think>[\s\S]*?<\/think>/g, '');

  text = text.replace(/"(name|arguments)\s*=\s*([^"{}[\],]+)"/g, '"$1": "$2"');
  text = text.replace(/"(\w+)"\s*=\s*/g, '"$1": ');

  // Primary: extract all <tool_call> blocks
  for (const match of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)) {
    const raw = match[1];
    const normalized = raw.replace(/\bTrue\b/g, 'true').replace(/\bFalse\b/g, 'false').replace(/\bNone\b/g, 'null');
    try {
      const parsed = JSON.parse(normalized);
      if (parsed.name) calls.push({ name: parsed.name, arguments: parsed.arguments || {} });
    } catch (e) {
      console.warn(`[parseToolCalls] JSON.parse failed: ${e.message}`);
      const repaired = repairToolCallJson(normalized);
      if (repaired) {
        calls.push(repaired);
      } else {
        console.error(`[parseToolCalls] Could not repair tool call. Raw (first 300 chars):\n${raw.slice(0, 300)}`);
      }
    }
  }
  if (calls.length > 0) return calls;

  // Fallback: detect bare JSON tool calls without tags
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{"name"', i);
    if (start === -1) break;
    let depth = 0, end = start, inString = false;
    for (let j = start; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (ch === '\\') { j++; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j + 1; break; } }
    }
    let candidate = text.slice(start, end);
    if (depth > 0) candidate += '}'.repeat(depth);
    let parsed = null;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      let escaped = '';
      let esc_inStr = false;
      for (let j = 0; j < candidate.length; j++) {
        const ch = candidate[j];
        if (esc_inStr) {
          if (ch === '\\') { escaped += ch + (candidate[++j] || ''); continue; }
          if (ch === '"') esc_inStr = false;
          if (ch === '\n') { escaped += '\\n'; continue; }
          if (ch === '\r') { escaped += '\\r'; continue; }
          if (ch === '\t') { escaped += '\\t'; continue; }
          escaped += ch;
        } else {
          if (ch === '"') esc_inStr = true;
          escaped += ch;
        }
      }
      try {
        parsed = JSON.parse(escaped);
        console.log(`[parseToolCalls] bare JSON parsed after smart-escaping newlines`);
      } catch {
        const repaired = repairToolCallJson(candidate);
        if (repaired) calls.push(repaired);
      }
    }
    if (parsed && parsed.name && typeof parsed.arguments === 'object') {
      const args = parsed.arguments.arguments ? parsed.arguments.arguments : parsed.arguments;
      calls.push({ name: parsed.name, arguments: args });
    }
    i = end > start ? end : start + 1;
  }
  return calls;
}

// ── Execute a tool by name ──────────────────────────
export async function executeTool(name, args, context) {
  if (disabledTools.has(name)) {
    return JSON.stringify({ error: `Tool "${name}" is currently disabled.` });
  }
  let tool = tools[name];
  if (!tool) {
    const available = Object.keys(tools);
    const close = available.find(t => t.includes(name) || name.includes(t));
    if (close) {
      console.log(`[tools] Auto-corrected "${name}" → "${close}"`);
      tool = tools[close];
      name = close;
    } else {
      return JSON.stringify({ error: `Unknown tool: ${name}. Available tools: ${available.join(', ')}` });
    }
  }
  try {
    console.log(`[tools] executing "${name}" args=${JSON.stringify(args).slice(0, 200)}`);
    const t0 = Date.now();
    const result = await tool.execute(args, context);
    console.log(`[tools] "${name}" completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const action = args?.action || 'call';
    const { _images, _rateMap, _diff, ...loggableResult } = result || {};
    if (_images) loggableResult._imageCount = _images.length;
    if (_rateMap) loggableResult._rateCount = Object.keys(_rateMap).length;
    if (_diff) loggableResult._hasDiff = true;
    const loggableArgs = { ...args };
    if (loggableArgs.content && loggableArgs.content.length > 200) loggableArgs.content = loggableArgs.content.slice(0, 200) + '...[truncated]';
    if (loggableArgs.new_string && loggableArgs.new_string.length > 200) loggableArgs.new_string = loggableArgs.new_string.slice(0, 200) + '...[truncated]';
    if (loggableArgs.old_string && loggableArgs.old_string.length > 200) loggableArgs.old_string = loggableArgs.old_string.slice(0, 200) + '...[truncated]';
    if (loggableArgs.code && loggableArgs.code.length > 2000) loggableArgs.code = loggableArgs.code.slice(0, 2000) + '...[truncated]';
    await logToolCall(name, action, { args: loggableArgs, rawResult: loggableResult, formattedResult: loggableResult });
    return JSON.stringify(result);
  } catch (err) {
    console.error(`[tools] "${name}" error: ${err.message}`);
    await logToolCall(name, args?.action || 'error', { args, rawResult: { error: err.message }, formattedResult: { error: err.message } });
    return JSON.stringify({ error: err.message });
  }
}
