// Llama Dashboard: what the app can learn about the llama-server it talks to.
//
// Sources, none of which need a change to how llama-server is started:
//   /props, /v1/models, /slots   build, model, window, slots, sampling in force
//   /proc/<pid>, ps              the real launch flags, uptime, RAM   (server on this machine)
//   nvidia-smi                   VRAM, temperature, power              (this machine)
//   kernel journal               NVRM Xid events                       (this machine)
//   completion `timings`         per-answer speed, cache reuse, draft acceptance (recorded here)
//   /metrics                     server-lifetime totals — only when started with --metrics
//   git + GitHub API             how far the checkout is behind upstream
//
// The update check only reports. Nothing here pulls, builds or restarts anything.
//
// Parsers are pure and exported for test/llamaDashboard.test.js; collectors do the I/O and
// cache per section, so the panel can poll every few seconds.

import { execFile } from 'child_process';
import { readdir, readFile, readlink } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import config from '../config.js';
import slots from './slots.js';

// ── Pure parsers ─────────────────────────────────────

// 'b11719-5aeac37a3' → { build: 11719, commit: '5aeac37a3' }
export function parseBuildInfo(s) {
  const m = /^b?(\d+)-([0-9a-f]{6,40})$/i.exec(String(s || '').trim());
  return m ? { build: Number(m[1]), commit: m[2] } : { build: null, commit: null };
}

// /proc/<pid>/cmdline (NUL-separated) → argv
export function parseCmdline(raw) {
  return String(raw || '').split('\0').filter(Boolean);
}

// argv → [{ flag, value }]: a token starting with '-' opens an entry, the tokens after it
// (until the next flag) are its value. A negative number is a value, not a flag.
export function flagsFromArgv(argv) {
  const out = [];
  for (const tok of argv.slice(1)) {
    const isFlag = /^--?[A-Za-z]/.test(tok);
    if (isFlag || !out.length) out.push({ flag: isFlag ? tok : '', value: isFlag ? '' : tok });
    else out[out.length - 1].value += (out[out.length - 1].value ? ' ' : '') + tok;
  }
  return out;
}

export function flagValue(flags, ...names) {
  const hit = flags.find(f => names.includes(f.flag));
  return hit ? hit.value : null;
}

// Prometheus text → { name: number } (prefix 'llamacpp:' dropped) plus labeled series as
// name → { labelValue: number } for the one labeled counter llama-server emits.
export function parsePrometheus(text) {
  const values = {};
  const labeled = {};
  for (const line of String(text || '').split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].replace(/^llamacpp:/, '');
    const num = Number(m[3]);
    if (!Number.isFinite(num)) continue;
    if (m[2]) {
      const lv = /="([^"]*)"/.exec(m[2]);
      (labeled[name] ||= {})[lv ? lv[1] : m[2]] = num;
    } else values[name] = num;
  }
  return { values, labeled };
}

const num = (s) => { const n = Number(String(s).trim()); return Number.isFinite(n) ? n : null; };

// `nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,driver_version
//   --format=csv,noheader,nounits` and `--query-compute-apps=pid,used_memory` → gpus + per-pid MiB
export function parseNvidiaSmi(gpuCsv, appsCsv = '') {
  const gpus = String(gpuCsv || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const c = l.split(',').map(s => s.trim());
    return {
      index: num(c[0]), name: c[1] || '', memUsedMiB: num(c[2]), memTotalMiB: num(c[3]),
      utilPct: num(c[4]), tempC: num(c[5]), powerW: num(c[6]), driver: c[7] || '',
    };
  }).filter(g => g.memTotalMiB);
  const apps = {};
  for (const l of String(appsCsv || '').split('\n')) {
    const c = l.split(',').map(s => s.trim());
    const pid = num(c[0]); const mem = num(c[1]);
    if (pid && mem != null) apps[pid] = (apps[pid] || 0) + mem;
  }
  return { gpus, apps };
}

// Kernel journal lines (`journalctl -o short-iso`) → Xid events, oldest first.
// "2026-11-16T21:47:22-0500 host kernel: NVRM: Xid (PCI:0000:01:00): 8, pid=9594, name=llama-server, channel 0x11"
export function parseXidLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(\S+)\s.*NVRM: Xid \(([^)]*)\): (\d+),?\s*(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[4] || '';
    const at = new Date(m[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    out.push({
      at: Number.isNaN(at.getTime()) ? null : at.toISOString(),
      device: m[2],
      code: Number(m[3]),
      pid: num((/pid=(\d+)/.exec(rest) || [])[1] ?? NaN),
      process: (/name=([^,\s]+)/.exec(rest) || [])[1] || null,
      detail: rest.slice(0, 200),
    });
  }
  return out;
}

// What the common codes mean, in a few words (NVIDIA "Xid Errors" documentation).
export const XID_MEANING = {
  8: 'GPU channel hang',
  13: 'graphics engine exception',
  31: 'GPU memory page fault',
  43: 'GPU stopped processing',
  48: 'double-bit ECC error',
  62: 'internal micro-controller halt',
  69: 'graphics engine class error',
  79: 'GPU has fallen off the bus',
  109: 'context switch timeout',
  119: 'GSP RPC timeout',
};

// Commit subjects worth a look on this setup: the server, CUDA, speculative decoding, the KV
// cache, chat templates / tool-call parsing. The rest (other backends, UI, docs, CI) is counted.
const RELEVANT = /^(server|llama-server|ggml-cuda|cuda|spec[\w-]*|speculative|mtp|draft|kv[\w-]*|llama|common|chat|jinja|sampling|sampler|ggml|gguf|context|memory)\s*(\([^)]*\))?\s*:/i;
const RELEVANT_WORD = /\b(cuda|mtp|speculative|kv cache|flash[- ]attn|tool[- ]call|qwen|slot)\b/i;
const NOT_RELEVANT = /^(sycl|vulkan|metal|opencl|cann|webgpu|rpc|ui|webui|docs?|ci|build|nix|readme|tests?|mtmd|tts|android|swift|examples?)\b[^:]*:/i;

export function isRelevantCommit(subject) {
  const s = String(subject || '');
  if (NOT_RELEVANT.test(s)) return false;
  return RELEVANT.test(s) || RELEVANT_WORD.test(s);
}

// GitHub /commits items → [{ sha, subject, date, url, relevant }], input order kept (newest first)
export function summarizeCommits(items) {
  return (Array.isArray(items) ? items : []).map(c => {
    const subject = String(c?.commit?.message || '').split('\n')[0].slice(0, 160);
    return {
      sha: String(c?.sha || '').slice(0, 9),
      subject,
      date: c?.commit?.committer?.date || c?.commit?.author?.date || null,
      url: c?.html_url || null,
      relevant: isRelevantCommit(subject),
    };
  });
}

// 'https://github.com/ggml-org/llama.cpp.git' | 'git@github.com:ggml-org/llama.cpp.git' → 'ggml-org/llama.cpp'
export function githubRepoOf(remoteUrl) {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(remoteUrl || '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

// One completion's `timings` → the numbers worth keeping; null for anything that is not a
// llama-server timings object (the Claude backend sends `usage`).
export function speedOf(timings) {
  if (!timings || typeof timings.predicted_per_second !== 'number') return null;
  const r1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
  const s = {
    gen: r1(timings.predicted_per_second),          // generated tokens / s
    genN: timings.predicted_n ?? 0,
    prompt: r1(timings.prompt_per_second),          // prompt tokens processed / s
    promptN: timings.prompt_n ?? 0,                  // processed (not served from the KV cache)
    cacheN: timings.cache_n ?? 0,                    // served from the KV cache
  };
  if (typeof timings.draft_n === 'number') {
    s.draftN = timings.draft_n;
    s.draftAccepted = timings.draft_n_accepted ?? 0;
  }
  return s;
}

const median = (arr) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : Math.round(((a[mid - 1] + a[mid]) / 2) * 10) / 10;
};
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// Samples (speedOf results, oldest first) → the Speed card.
// Rounds under MIN_GEN tokens are left out of the generation speed: their rate is start-up noise.
export const MIN_GEN_TOKENS = 20;
export function summarizeSpeed(samples) {
  const all = (samples || []).filter(Boolean);
  const gen = all.filter(s => s.genN >= MIN_GEN_TOKENS && s.gen != null);
  const processed = all.filter(s => s.promptN >= 200 && s.prompt != null);
  const sum = (k) => all.reduce((n, s) => n + (s[k] || 0), 0);
  const drafted = sum('draftN');
  const promptN = sum('promptN');
  const cacheN = sum('cacheN');
  return {
    answers: all.length,
    genTps: { median: median(gen.map(s => s.gen)), min: gen.length ? Math.min(...gen.map(s => s.gen)) : null, max: gen.length ? Math.max(...gen.map(s => s.gen)) : null, last: gen.length ? gen[gen.length - 1].gen : null },
    promptTps: { median: median(processed.map(s => s.prompt)) },
    generatedTokens: sum('genN'),
    promptTokensProcessed: promptN,
    promptTokensCached: cacheN,
    cacheSharePct: pct(cacheN, cacheN + promptN),
    draft: drafted ? { drafted, accepted: sum('draftAccepted'), acceptPct: pct(sum('draftAccepted'), drafted) } : null,
    series: gen.slice(-60).map(s => s.gen),
  };
}

// ── Speed recorder (in memory, since this app started) ───────────────────────

const MAX_SAMPLES = 500;
const samples = [];
let recordingSince = Date.now();

// Called by both tool loops and collectChatCompletion with the raw `timings` of a completion.
export function recordTimings(timings) {
  const s = speedOf(timings);
  if (!s) return null;
  samples.push({ ...s, at: Date.now() });
  if (samples.length > MAX_SAMPLES) samples.shift();
  return s;
}

export function resetSpeed() { samples.length = 0; recordingSince = Date.now(); }

// ── Collectors ───────────────────────────────────────

const run = (cmd, args, { timeout = 4000, cwd } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, cwd, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    resolve(err ? null : String(stdout));
  });
});

const cache = new Map();   // key → { at, value, pending }
async function cached(key, ttlMs, fn, force = false) {
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < ttlMs) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = (async () => {
    let value;
    try { value = await fn(); } catch (e) { value = { error: e.message }; }
    cache.set(key, { at: Date.now(), value });
    return value;
  })();
  cache.set(key, { ...(hit || { at: 0, value: null }), pending });
  return pending;
}

async function getJson(path, timeoutMs = 3000) {
  const res = await fetch(`${config.llama.baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return res.json();
}

function llamaUrl() {
  try { return new URL(config.llama.baseUrl); } catch { return null; }
}
export function isLocalHost(hostname) {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(String(hostname || '').toLowerCase());
}

async function collectServer() {
  const [props, models] = await Promise.all([
    getJson('/props').catch(() => null),
    getJson('/v1/models').catch(() => null),
  ]);
  if (!props) return { reachable: false };
  const meta = models?.data?.[0]?.meta || {};
  const bi = parseBuildInfo(props.build_info);
  return {
    reachable: true,
    buildInfo: props.build_info || null,
    build: bi.build,
    commit: bi.commit,
    model: props.model_alias || models?.data?.[0]?.id || null,
    modelPath: props.model_path || null,
    quant: props.model_ftype || meta.ftype || null,
    params: meta.n_params ?? null,
    sizeBytes: meta.size ?? null,
    nCtx: props.default_generation_settings?.n_ctx ?? meta.n_ctx ?? null,
    nCtxTrain: meta.n_ctx_train ?? null,
    totalSlots: props.total_slots ?? null,
    modalities: props.modalities || {},
    metricsEndpoint: !!props.endpoint_metrics,
    sleeping: !!props.is_sleeping,
  };
}

function collectSlots() {
  return slots.getCachedSlots().map(s => ({
    id: s.id,
    nCtx: s.n_ctx ?? null,
    processing: !!s.is_processing,
    promptTokens: s.n_prompt_tokens ?? null,
    speculative: s.params?.['speculative.types'] || (s.speculative ? 'on' : 'none'),
    sampling: s.params ? {
      temperature: s.params.temperature, top_p: s.params.top_p, top_k: s.params.top_k,
      min_p: s.params.min_p, repeat_penalty: s.params.repeat_penalty,
    } : null,
  }));
}

// The llama-server process behind LLAMA_URL, when it runs on this machine.
async function collectProcess() {
  const url = llamaUrl();
  if (!url || !isLocalHost(url.hostname) || process.platform !== 'linux') return null;
  const wantPort = url.port || (url.protocol === 'https:' ? '443' : '80');
  let pids;
  try { pids = (await readdir('/proc')).filter(n => /^\d+$/.test(n)); } catch { return null; }
  const found = [];
  for (const pid of pids) {
    try {
      const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim();
      if (comm !== 'llama-server') continue;
      const argv = parseCmdline(await readFile(`/proc/${pid}/cmdline`, 'utf8'));
      const flags = flagsFromArgv(argv);
      found.push({ pid: Number(pid), argv, flags, port: flagValue(flags, '--port') || '8080' });
    } catch { /* gone, or not ours */ }
  }
  const proc = found.find(p => p.port === wantPort) || (found.length === 1 ? found[0] : null);
  if (!proc) return null;
  const [exe, cwd, ps] = await Promise.all([
    readlink(`/proc/${proc.pid}/exe`).catch(() => null),
    readlink(`/proc/${proc.pid}/cwd`).catch(() => null),
    run('ps', ['-o', 'etimes=,rss=', '-p', String(proc.pid)]),
  ]);
  const [etimes, rssKb] = (ps || '').trim().split(/\s+/).map(Number);
  return {
    pid: proc.pid,
    exe, cwd,
    uptimeSec: Number.isFinite(etimes) ? etimes : null,
    startedAt: Number.isFinite(etimes) ? new Date(Date.now() - etimes * 1000).toISOString() : null,
    rssBytes: Number.isFinite(rssKb) ? rssKb * 1024 : null,
    flags: proc.flags,
    command: proc.argv.join(' '),
  };
}

async function collectGpu(pid) {
  const [gpuCsv, appsCsv] = await Promise.all([
    run('nvidia-smi', ['--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,driver_version', '--format=csv,noheader,nounits']),
    run('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits']),
  ]);
  if (!gpuCsv) return null;
  const { gpus, apps } = parseNvidiaSmi(gpuCsv, appsCsv || '');
  if (!gpus.length) return null;
  return { gpus, llamaMiB: pid != null ? apps[pid] ?? null : null };
}

// `-t kernel`, not `-k`: -k is the current boot only, and an Xid usually predates it.
const XID_DAYS = 90;
async function collectXid() {
  if (process.platform !== 'linux') return null;
  const base = ['-t', 'kernel', '--since', `-${XID_DAYS} days`, '--no-pager', '-o', 'short-iso'];
  let out = await run('journalctl', [...base, '-g', 'NVRM: Xid'], { timeout: 8000 });
  if (out == null) out = await run('journalctl', base, { timeout: 15000 });   // journalctl built without --grep
  if (out == null) return null;
  const events = parseXidLines(out).map(e => ({ ...e, meaning: XID_MEANING[e.code] || null }));
  return { days: XID_DAYS, events: events.slice(-20).reverse(), total: events.length };
}

async function collectMetrics() {
  const res = await fetch(`${config.llama.baseUrl}/metrics`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  const { values, labeled } = parsePrometheus(await res.text());
  const drafted = values.spec_decode_num_draft_tokens_total || 0;
  const accepted = values.spec_decode_num_accepted_tokens_total || 0;
  const perPos = labeled.spec_decode_num_accepted_tokens_per_pos_total || null;
  const drafts = values.spec_decode_num_drafts_total || 0;
  return {
    promptTokens: values.prompt_tokens_total ?? null,
    promptTokensCached: values.prompt_tokens_cached_total ?? null,
    generatedTokens: values.tokens_predicted_total ?? null,
    genTps: values.predicted_tokens_seconds ?? null,
    promptTps: values.prompt_tokens_seconds ?? null,
    requestsProcessing: values.requests_processing ?? null,
    requestsDeferred: values.requests_deferred ?? null,
    draft: drafted ? { drafted, accepted, drafts, acceptPct: pct(accepted, drafted) } : null,
    // share of drafts whose token at position i was accepted
    draftPerPosition: perPos && drafts
      ? Object.keys(perPos).sort((a, b) => a - b).map(k => ({ position: Number(k), accepted: perPos[k], pct: pct(perPos[k], drafts) }))
      : null,
  };
}

// The checkout the running binary was built from: LLAMA_CPP_DIR, else the nearest directory
// above the executable that has a .git.
export function findRepoDir(exe) {
  if (process.env.LLAMA_CPP_DIR) return existsSync(join(process.env.LLAMA_CPP_DIR, '.git')) ? process.env.LLAMA_CPP_DIR : null;
  let dir = exe ? dirname(exe) : null;
  for (let i = 0; dir && i < 6; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

async function collectCheckout(exe) {
  const dir = findRepoDir(exe);
  if (!dir) return null;
  const git = (...a) => run('git', ['-C', dir, ...a]).then(s => (s == null ? null : s.trim()));
  const [head, date, describe, branch, remote, dirty] = await Promise.all([
    git('rev-parse', 'HEAD'), git('log', '-1', '--format=%cI'), git('describe', '--tags', '--always'),
    git('rev-parse', '--abbrev-ref', 'HEAD'), git('remote', 'get-url', 'origin'), git('status', '--porcelain', '-uno'),
  ]);
  if (!head) return null;
  return { dir, head, date, describe, branch, remote, repo: githubRepoOf(remote), modified: !!dirty };
}

const GH_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'llama-dashboard' };
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(8000) });
  if (res.status === 403 || res.status === 429) throw new Error('GitHub rate limit reached — try again in an hour');
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return res.json();
}

// Four unauthenticated GitHub requests (limit: 60 an hour), hence the long cache.
export const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;
async function collectUpdates(checkout) {
  if (!checkout?.repo) return { error: 'The checkout has no GitHub origin to compare against.' };
  const { repo, head } = checkout;
  const info = await gh(`/repos/${repo}`);
  const branch = info.default_branch || 'master';
  const [cmp, newest, release] = await Promise.all([
    gh(`/repos/${repo}/compare/${head}...${branch}?per_page=1`),
    gh(`/repos/${repo}/commits?sha=${branch}&per_page=100`),
    gh(`/repos/${repo}/releases/latest`).catch(() => null),
  ]);
  const behind = cmp.ahead_by ?? 0;          // upstream is ahead of the checkout by this many
  const listed = summarizeCommits(newest).slice(0, Math.min(behind, 100));
  const relevant = listed.filter(c => c.relevant);
  return {
    checkedAt: new Date().toISOString(),
    repo, branch,
    behind,
    localAhead: cmp.behind_by ?? 0,          // local commits upstream does not have
    upstreamHead: String(newest?.[0]?.sha || '').slice(0, 9) || null,
    upstreamDate: newest?.[0]?.commit?.committer?.date || null,
    release: release ? {
      tag: release.tag_name, name: release.name || release.tag_name,
      publishedAt: release.published_at, url: release.html_url,
      newerThanBuild: !!(checkout.date && release.published_at && new Date(release.published_at) > new Date(checkout.date)),
    } : null,
    listedCount: listed.length,
    relevant: relevant.slice(0, 40),
    relevantCount: relevant.length,
    compareUrl: `https://github.com/${repo}/compare/${head.slice(0, 9)}...${branch}`,
  };
}

// ── The dashboard ────────────────────────────────────

const XID_RECENT_MS = 48 * 60 * 60 * 1000;

export function buildAlerts({ server, gpu, xid, updates }) {
  const alerts = [];
  if (server && !server.reachable) alerts.push({ level: 'error', text: 'llama-server is not answering.' });
  const recent = (xid?.events || []).find(e => e.at && Date.now() - new Date(e.at).getTime() < XID_RECENT_MS);
  if (recent) alerts.push({ level: 'warn', text: `GPU error Xid ${recent.code} in the last 48 hours (${recent.at.slice(0, 16).replace('T', ' ')} UTC).` });
  for (const g of gpu?.gpus || []) {
    if (g.memTotalMiB && g.memUsedMiB / g.memTotalMiB > 0.97) alerts.push({ level: 'warn', text: `GPU ${g.index} memory is ${Math.round((g.memUsedMiB / g.memTotalMiB) * 100)}% full.` });
    if (g.tempC != null && g.tempC >= 85) alerts.push({ level: 'warn', text: `GPU ${g.index} is at ${g.tempC} °C.` });
  }
  if (updates?.behind > 0) alerts.push({ level: 'info', text: `llama.cpp checkout is ${updates.behind} commits behind ${updates.branch}.` });
  return alerts;
}

// The binary last seen running: keeps the Updates card alive while llama-server is stopped
// (for example during the rebuild the card just suggested).
let lastExe = null;

export async function getDashboard({ checkUpdates = false } = {}) {
  const [server, proc] = await Promise.all([
    cached('server', 15_000, collectServer),
    cached('process', 5_000, collectProcess),
  ]);
  if (proc?.exe) lastExe = proc.exe;
  // nvidia-smi, the kernel journal and the binary's checkout describe THIS machine. With
  // llama-server elsewhere they would be someone else's GPU and errors, so they are left out
  // (the checkout only when LLAMA_CPP_DIR names one explicitly).
  const local = isLocalHost(llamaUrl()?.hostname);
  // Machine readings are Linux-only by decision (2026-11-21): elsewhere nothing is probed at all,
  // not even nvidia-smi on Windows, and the panel shows only what llama-server itself reports.
  const machine = local && process.platform === 'linux';
  const [gpu, xid, metrics, checkout] = await Promise.all([
    machine ? cached('gpu', 2_000, () => collectGpu(proc?.pid ?? null)) : null,
    machine ? cached('xid', 60_000, collectXid) : null,
    server?.metricsEndpoint ? cached('metrics', 3_000, collectMetrics) : null,
    local || process.env.LLAMA_CPP_DIR ? cached('checkout', 60_000, () => collectCheckout(proc?.exe || lastExe)) : null,
  ]);
  // Never checked → check once in the background; afterwards every UPDATE_TTL_MS or on request.
  let updates = cache.get('updates')?.value ?? null;
  const updatesAt = cache.get('updates')?.at ?? 0;
  if (checkout?.repo && (checkUpdates || !updatesAt || Date.now() - updatesAt > UPDATE_TTL_MS)) {
    const p = cached('updates', checkUpdates ? 60_000 : UPDATE_TTL_MS, () => collectUpdates(checkout), true);
    if (checkUpdates) updates = await p; else p.catch(() => {});
  }
  const speed = { since: new Date(recordingSince).toISOString(), ...summarizeSpeed(samples) };
  return {
    at: new Date().toISOString(),
    backend: config.llm.backend,
    url: config.llama.baseUrl,
    local,
    platform: process.platform,
    server, process: proc, slots: collectSlots(), gpu, xid, metrics, speed, checkout, updates,
    alerts: buildAlerts({ server, gpu, xid, updates }),
  };
}

export default { getDashboard, recordTimings, resetSpeed };
