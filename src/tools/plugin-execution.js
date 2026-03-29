import { writeFile, unlink } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import config from '../config.js';
import { fixPythonBooleans, tagLineCount } from './index.js';

const PYTHON_VENV = (config.python.venvPath || '').replace(/^~/, homedir());

export default {
  group: 'execution',
  routing: [],
  prompt: `## Code Execution
- You are a LOCAL assistant running on the user's machine. You have real shell access via the source_run tool. When the user asks you to run commands, install packages, list files, or perform any shell operation — use source_run. NEVER say you cannot run commands or don't have access to the user's system.
- run_python code quality — MANDATORY rules:
  1. FORBIDDEN: iterrows(), itertuples(), for-loops over DataFrame rows, iloc[0] inside loops. Use ONLY vectorized pandas: groupby().agg(), merge(), df[condition]['col'].sum(). Any script using iterrows WILL FAIL.
  2. Keep scripts under 40 lines. One task per script.
  3. Pick ONE output: print() a short summary OR save a file. Not both.
  4. Before submitting: mentally verify every string literal, bracket, quote, and f-string brace. A syntax error wastes an entire tool round.
- run_python error handling: If a script fails, DO NOT retry with the same approach. First run a small diagnostic script (e.g. print columns, print dtypes, print first row) to understand the data, then fix the actual issue. Maximum 1 retry after diagnosis.
- WHEN TO USE run_python vs direct answer: USE run_python for: any calculation involving more than 3 numbers, aggregations (sum, avg, count, group-by), data with more than 10 rows, date math, filtering/sorting data, or any question where getting the wrong number would be harmful. ANSWER DIRECTLY for: single value lookups, qualitative questions, comparing 2-3 values, or explaining what data means. RULE OF THUMB: if you need to count, sum, or iterate — use Python. Never do mental math on financial data.`,
  tools: {
    run_python: {
      description: 'Execute a Python script in the source project directory. Requires user approval. Requires "code" (Python source). The script runs in the current source project directory (same as source_read/source_write).\n\nOutput rules:\n- Quick answers (single number, short list, yes/no) → print() to console.\n- Reports, tables, formatted results → print() a summary.\n- ALWAYS print() something so the user sees immediate feedback.\n- Keep scripts concise. Use pandas for CSV processing when appropriate.',
      parameters: { code: 'string' },
      execute: async ({ code }, context) => {
        const t0 = Date.now();
        const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
        if (!code?.trim()) return { error: 'code is required' };
        if (!context?.confirmFn) return { error: 'No confirmation channel available' };

        let approved = true;
        if (context.autorun) {
          console.log(`[run_python] autorun enabled, skipping confirmation (${elapsed()})`);
        } else {
          console.log(`[run_python] requesting user confirmation...`);
          approved = await context.confirmFn(`Python script:\n${code}`);
          console.log(`[run_python] confirmation ${approved ? 'approved' : 'denied'} (${elapsed()})`);
        }
        if (!approved) return { denied: true, message: 'User denied Python execution.' };

        code = fixPythonBooleans(code);
        // Fix double-escaping: LLM sometimes produces a backslash + real newline
        code = code.replace(/(["'])([^"']*)\\\n([^"']*)\1/g, (m, q, before, after) => {
          return `${q}${before}\\n${after}${q}`;
        });

        const projectDir = resolve(config.sourceDir || process.env.HOME);
        const tmpFile = join(projectDir, '.tmp_script.py');
        await writeFile(tmpFile, code, 'utf-8');

        const pythonBin = PYTHON_VENV ? join(PYTHON_VENV, 'bin', 'python') : 'python3';
        console.log(`[run_python] spawning: ${pythonBin} ${tmpFile} cwd=${projectDir} (timeout=120s) (${elapsed()})`);
        const TIMEOUT_MS = 120000;
        const { exitCode, stdout, stderr, timedOut } = await new Promise((resolve) => {
          let out = '', err = '', resolved = false;
          const finish = (result) => { if (!resolved) { resolved = true; resolve(result); } };
          const proc = spawn(pythonBin, [tmpFile], {
            cwd: projectDir,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const killTimer = setTimeout(() => {
            console.warn(`[run_python] TIMEOUT after ${TIMEOUT_MS / 1000}s — killing pid ${proc.pid}`);
            proc.kill('SIGKILL');
            finish({ exitCode: 137, stdout: out, stderr: err + '\n[run_python] Process killed: exceeded 120s timeout', timedOut: true });
          }, TIMEOUT_MS);
          proc.stdout.on('data', (d) => { if (out.length < 2 * 1024 * 1024) out += d; });
          proc.stderr.on('data', (d) => { if (err.length < 2 * 1024 * 1024) err += d; });
          proc.on('close', (code) => { clearTimeout(killTimer); finish({ exitCode: code ?? 1, stdout: out, stderr: err, timedOut: false }); });
          proc.on('error', (e) => { clearTimeout(killTimer); finish({ exitCode: 1, stdout: '', stderr: e.message, timedOut: false }); });
        });
        console.log(`[run_python] process exited: code=${exitCode} timedOut=${timedOut} stdout=${stdout.length}B stderr=${stderr.length}B (${elapsed()})`);
        await unlink(tmpFile).catch(() => {});

        const result = { exitCode, stdout: tagLineCount(stdout, 8000) };
        if (timedOut) result.timedOut = true;
        if (stderr) result.stderr = stderr.slice(0, 4000);
        console.log(`[run_python] done (${elapsed()})`);
        return result;
      },
    },
  },
};
