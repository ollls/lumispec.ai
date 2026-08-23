// Analysis A — what the tool logs say about parse risk.
// Reads logs/tools_*.log, classifies every executed tool call by payload shape.
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const SEP = '═'.repeat(80);

// Tools whose args carry large multi-line string payloads (code/content).
// These are exactly the three the manual arg-scraper at index.js:930 covers.
const CODE_TOOLS = new Set(['run_python', 'source_write', 'source_edit']);

const files = (await readdir(LOG_DIR)).filter(f => f.startsWith('tools_') && f.endsWith('.log')).sort();

const stats = new Map();   // tool -> {n, err, argChars[], nlArgs, quoteArgs, maxArg}
let total = 0, totalErr = 0;
const byDay = new Map();

function bump(tool) {
  if (!stats.has(tool)) stats.set(tool, { n: 0, err: 0, argChars: [], nlArgs: 0, quoteArgs: 0, maxArg: 0 });
  return stats.get(tool);
}

for (const f of files) {
  const text = await readFile(join(LOG_DIR, f), 'utf-8');
  const day = f.slice(6, 16);
  for (const chunk of text.split(SEP)) {
    const header = chunk.match(/^\s*\[([0-9T:.\-Z]+)\]\s+(\w+):(\S*)/);
    if (!header) continue;
    const tool = header[2];
    const s = bump(tool);
    s.n++; total++;
    byDay.set(day, (byDay.get(day) || 0) + 1);

    // error entries: RAW block opens with an "error" key
    if (/─── RAW ───\s*\{\s*"error"/.test(chunk)) { s.err++; totalErr++; }

    // ARGS payload shape — the thing the model had to emit as JSON-inside-text
    const argsLine = chunk.match(/\nARGS: (.*)/);
    if (argsLine) {
      const a = argsLine[1];
      s.argChars.push(a.length);
      s.maxArg = Math.max(s.maxArg, a.length);
      // escaped newlines inside string values = the exact failure mode the
      // "smart-escape newlines" repair layer (index.js:900) exists to fix
      const nl = (a.match(/\\n/g) || []).length;
      if (nl > 0) s.nlArgs++;
      const q = (a.match(/\\"/g) || []).length;
      if (q > 0) s.quoteArgs++;
    }
  }
}

const pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : '—';
const med = arr => { if (!arr.length) return 0; const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

console.log(`\n=== VOLUME ===`);
console.log(`log files: ${files.length}   days: ${byDay.size}   total executed tool calls: ${total}   error results: ${totalErr} (${pct(totalErr, total)})`);
console.log([...byDay.entries()].map(([d, n]) => `  ${d}  ${String(n).padStart(5)}`).join('\n'));

const rows = [...stats.entries()].sort((a, b) => b[1].n - a[1].n);
console.log(`\n=== PER-TOOL CALL DISTRIBUTION & PAYLOAD SHAPE ===`);
console.log(`${'tool'.padEnd(20)} ${'calls'.padStart(6)} ${'share'.padStart(7)} ${'err'.padStart(6)} ${'medArg'.padStart(7)} ${'maxArg'.padStart(8)} ${'w/ \\n'.padStart(7)} ${'w/ \\"'.padStart(7)}`);
for (const [tool, s] of rows) {
  console.log(
    `${tool.padEnd(20)} ${String(s.n).padStart(6)} ${pct(s.n, total).padStart(7)} ${pct(s.err, s.n).padStart(6)} ` +
    `${String(med(s.argChars)).padStart(7)} ${String(s.maxArg).padStart(8)} ${pct(s.nlArgs, s.n).padStart(7)} ${pct(s.quoteArgs, s.n).padStart(7)}`
  );
}

// Risk split: code-carrying vs everything else
let codeN = 0, codeNl = 0, restN = 0, restNl = 0, codeChars = 0, restChars = 0;
for (const [tool, s] of stats) {
  const sum = s.argChars.reduce((a, b) => a + b, 0);
  if (CODE_TOOLS.has(tool)) { codeN += s.n; codeNl += s.nlArgs; codeChars += sum; }
  else { restN += s.n; restNl += s.nlArgs; restChars += sum; }
}
console.log(`\n=== RISK CONCENTRATION (hypothesis: JSON-in-text only hurts code-carrying tools) ===`);
console.log(`code-carrying (run_python, source_write, source_edit): ${codeN} calls (${pct(codeN, total)})`);
console.log(`   with embedded newlines: ${codeNl} (${pct(codeNl, codeN)} of them)   mean arg size: ${codeN ? Math.round(codeChars / codeN) : 0} chars`);
console.log(`all other tools:                                       ${restN} calls (${pct(restN, total)})`);
console.log(`   with embedded newlines: ${restNl} (${pct(restNl, restN)} of them)   mean arg size: ${restN ? Math.round(restChars / restN) : 0} chars`);
