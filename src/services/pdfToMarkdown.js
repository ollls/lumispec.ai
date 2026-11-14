// PDF → Markdown for Books: runs scripts/pdf_to_md.py (PyMuPDF) in the configured Python
// environment and reports page progress. The script's stdout protocol is one line per event:
// PAGES n · PROGRESS done n · DONE chars headings codeBlocks · ERROR message.

import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';
import { getPythonEnv, toolEnv } from './pythonEnv.js';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/pdf_to_md.py');
const TIMEOUT_MS = 30 * 60 * 1000;

/** One protocol line → event, or null for anything else the script prints. */
export function parseProgressLine(line) {
  let m;
  if ((m = line.match(/^PAGES (\d+)$/))) return { type: 'pages', total: Number(m[1]) };
  if ((m = line.match(/^PROGRESS (\d+) (\d+)$/))) return { type: 'progress', done: Number(m[1]), total: Number(m[2]) };
  if ((m = line.match(/^DONE (\d+) (\d+) (\d+)$/))) return { type: 'done', chars: Number(m[1]), headings: Number(m[2]), codeBlocks: Number(m[3]) };
  if ((m = line.match(/^ERROR (.*)$/))) return { type: 'error', message: m[1] };
  return null;
}

/**
 * Convert `pdfPath` into `outPath`. `onProgress({ done, total })` fires as pages are read.
 * Resolves { chars, headings, codeBlocks, pages }; rejects with a message fit for the user.
 */
export function convertPdf(pdfPath, outPath, { onProgress, python } = {}) {
  const env = getPythonEnv(config.python.venvPath);
  const bin = python || env.bin;
  return new Promise((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(bin, [SCRIPT, pdfPath, outPath], { env: toolEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { return reject(new Error(`could not start Python (${bin}): ${err.message}`)); }
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    let buf = '';
    let stderr = '';
    let pages = 0;
    let result = null;
    let error = null;
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const ev = parseProgressLine(line.trim());
        if (!ev) continue;
        if (ev.type === 'pages') { pages = ev.total; onProgress?.({ done: 0, total: pages }); }
        else if (ev.type === 'progress') onProgress?.({ done: ev.done, total: ev.total });
        else if (ev.type === 'done') result = { ...ev, pages };
        else if (ev.type === 'error') error = ev.message;
      }
    });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-2000); });
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`could not start Python (${bin}): ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (result && code === 0) return resolvePromise(result);
      if (error === 'MISSING_PYMUPDF') {
        return reject(new Error(`PyMuPDF is not installed in the Python environment. Install it with: ${env.install('pymupdf')}`));
      }
      reject(new Error(error || `the converter exited with code ${code}${stderr ? ` — ${stderr.trim().split('\n').pop()}` : ''}`));
    });
  });
}
