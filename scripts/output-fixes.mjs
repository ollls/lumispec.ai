#!/usr/bin/env node
// Output-error report over the route log (ROUTE_LOG=1): do tool-call errors climb as the context
// window fills?
//
//   node scripts/output-fixes.mjs            every logs/routes_*.jsonl
//   node scripts/output-fixes.mjs 2026-11    only files whose name contains the argument
//
// A round counts as an error round when the parser or run_python had to patch a call (`fixes`),
// or the loop had to re-prompt (edge `repair`) or gave up (`repair-limit`). Rounds are bucketed by
// how full the slot was when the round was generated (ctx.prompt / ctx.limit). Records written
// before 2026-11-15 carry no `ctx` and are counted separately.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../logs');
const filter = process.argv[2] || '';
const BUCKETS = [[0, 20], [20, 40], [40, 60], [60, 70], [70, 80], [80, 101]];

const files = (await readdir(LOG_DIR).catch(() => []))
  .filter(f => /^routes_.*\.jsonl$/.test(f) && f.includes(filter)).sort();
if (files.length === 0) { console.log(`No route logs in ${LOG_DIR}${filter ? ` matching "${filter}"` : ''}. Set ROUTE_LOG=1 in .env.`); process.exit(0); }

const rows = [];
for (const f of files) {
  for (const line of (await readFile(join(LOG_DIR, f), 'utf-8')).split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line */ }
  }
}

const isRepair = r => r.edge === 'repair' && /^(bare-json|malformed-tag)$/.test(r.reason || '') || r.reason === 'repair-limit';
const blank = () => ({ rounds: 0, toolRounds: 0, patched: 0, repairs: 0, fixes: {} });
const add = (cell, r) => {
  cell.rounds++;
  if (r.pred?.toolCalls > 0) cell.toolRounds++;
  if (r.fixes?.length) cell.patched++;
  if (isRepair(r)) cell.repairs++;
  for (const f of r.fixes || []) cell.fixes[f] = (cell.fixes[f] || 0) + 1;
};
const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : '—';

const byBackend = {};
for (const r of rows) {
  const b = (byBackend[r.backend || 'unrecorded'] ||= { buckets: BUCKETS.map(blank), noCtx: blank(), all: blank() });
  add(b.all, r);
  const fill = r.ctx?.limit > 0 && r.ctx.prompt > 0 ? 100 * r.ctx.prompt / r.ctx.limit : null;
  if (fill === null) { add(b.noCtx, r); continue; }
  add(b.buckets[BUCKETS.findIndex(([lo, hi]) => fill >= lo && fill < hi)] || b.buckets.at(-1), r);
}

console.log(`${files.length} log file(s), ${files[0].slice(7, 17)} … ${files.at(-1).slice(7, 17)}, ${rows.length} rounds\n`);
for (const [backend, b] of Object.entries(byBackend)) {
  console.log(`Backend: ${backend}`);
  console.log('  window fill   rounds  tool rounds  patched  re-prompted  error rate');
  const line = (label, c) => console.log(`  ${label.padEnd(12)} ${String(c.rounds).padStart(7)} ${String(c.toolRounds).padStart(12)} ${String(c.patched).padStart(8)} ${String(c.repairs).padStart(12)} ${pct(c.patched + c.repairs, c.rounds).padStart(11)}`);
  BUCKETS.forEach(([lo, hi], i) => line(`${lo}–${Math.min(hi, 100)}%`, b.buckets[i]));
  if (b.noCtx.rounds) line('not recorded', b.noCtx);
  line('all', b.all);
  const kinds = Object.entries(b.all.fixes).sort((x, y) => y[1] - x[1]);
  console.log(kinds.length ? `  patches: ${kinds.map(([k, n]) => `${k} ×${n}`).join(', ')}` : '  patches: none');
  console.log();
}
