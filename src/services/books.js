// Books — a library of indexed folders the model can chat against. See docs/BOOKS.md.
//
// A book is a folder of markdown / text files anywhere on disk — or one such file — (never
// modified) plus its own index directory under data/books/<id>/:
//
//   data/books/<id>/book.json            { id, name, sourceDir, sourceFile?, pdf?, createdAt }
//                                        sourceFile: the book is that one file in sourceDir,
//                                        nothing else in the directory belongs to it
//                                        pdf: the book was converted from this PDF; its markdown
//                                        is data/books/<id>/source/<name>.md (sourceDir points there)
//   data/books/<id>/index/<file>.idx.md        summary of a file that fits in one section
//   data/books/<id>/index/<file>.p003.idx.md   summary of section 3 of a longer file
//
// Files longer than MAX_PART_CHARS are split into sections at headings / paragraph breaks, so a
// whole novel in one .txt is indexed and read section by section. A section id is the file's
// relative path, plus "#n" when the file has more than one section ("ch01.md", "book.txt#12").
//
// Everything here takes the library root as an argument (default data/books) so the tests run
// against a temp directory; the LLM call that writes a summary is injected by the plugin.

import { mkdir, writeFile, readFile, stat, readdir, rm, rename, copyFile } from 'fs/promises';
import { resolve, relative, dirname, basename, isAbsolute, sep } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { parseFrontmatter, enforceFrontmatterFields } from './frontmatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BOOKS_ROOT = resolve(__dirname, '../../data/books');

export const MAX_PART_CHARS = 16000;      // one section: ~4K tokens to read, one LLM call to index
export const SOURCE_EXT_RE = /\.(md|markdown|txt)$/i;
const IGNORE_DIRS = new Set(['node_modules', '__pycache__', 'venv']);
const MAX_SEARCH_HITS = 8;
const MAX_CONTENTS = 200;

// ── Pure helpers ─────────────────────────────────────────

export function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48) || 'book';
}

/**
 * Cut a text into sections of at most `max` chars. Breaks fall on paragraph boundaries, and on
 * a markdown heading once the current section is at least half full, so chapters tend to start
 * a section. A single paragraph longer than `max` is cut hard. Joining the parts gives the text
 * back unchanged.
 */
export function splitIntoParts(text, max = MAX_PART_CHARS) {
  if (!text) return [''];
  if (text.length <= max) return [text];
  const segs = text.match(/[\s\S]*?(?:\n{2,}|$)/g).filter(Boolean);
  const parts = [];
  let cur = '';
  for (let seg of segs) {
    const heading = /^#{1,3} \S/.test(seg);
    if (cur && (cur.length + seg.length > max || (heading && cur.length >= max / 2))) {
      parts.push(cur);
      cur = '';
    }
    while (seg.length > max) {
      parts.push(seg.slice(0, max));
      seg = seg.slice(max);
    }
    cur += seg;
  }
  if (cur) parts.push(cur);
  return parts;
}

export function sectionId(path, part, total) {
  return total > 1 ? `${path}#${part}` : path;
}

export function parseSectionId(id) {
  const m = String(id || '').trim().match(/^(.*?)(?:#(\d+))?$/);
  return { path: m[1].replace(/^\.?\//, ''), part: m[2] ? Number(m[2]) : 1 };
}

/** First heading, else first non-empty line — what a section is called before it is indexed. */
export function titleOf(text) {
  const h = text.match(/^#{1,6}\s+(.+?)\s*#*\s*$/m);
  const line = h ? h[1] : (text.split('\n').find(l => l.trim()) || '').trim();
  return line.replace(/[*_`]/g, '').slice(0, 90) || '(untitled)';
}

/**
 * Pick one book from a user/model spec: exact id, exact name, else a name fragment that must
 * match exactly one book. Returns { book } or { error, candidates }.
 */
export function resolveBook(spec, books) {
  const q = String(spec ?? '').trim().toLowerCase();
  if (!q) return { error: 'No book named.', candidates: books.map(b => b.name) };
  const exact = books.find(b => b.id === q) || books.find(b => b.name.toLowerCase() === q);
  if (exact) return { book: exact };
  const hits = books.filter(b => b.name.toLowerCase().includes(q) || b.id.includes(slugify(q)));
  if (hits.length === 1) return { book: hits[0] };
  if (hits.length > 1) return { error: `"${spec}" matches ${hits.length} books — ask the user which one.`, candidates: hits.map(b => b.name) };
  return { error: `No book matches "${spec}".`, candidates: books.map(b => b.name) };
}

const STOPWORDS = new Set('the and for are was were with that this from what which when where who how why does did has have had not but you your about into than then them they their there its can could would should will also any all more most some such only over under between'.split(' '));

export function queryTerms(query) {
  const q = String(query || '').toLowerCase();
  const words = (q.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || []).filter(w => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words.length ? words : [q.trim()].filter(Boolean))];
}

function countOf(hay, needle) {
  let n = 0;
  for (let i = hay.indexOf(needle); i !== -1 && n < 50; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Score one section against the query terms: summary hits weigh more than body hits. */
export function scoreSection({ text, summary }, terms, phrase) {
  const t = text.toLowerCase();
  const s = (summary || '').toLowerCase();
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const inText = countOf(t, term);
    const inSummary = s.includes(term);
    if (inText || inSummary) matched++;
    score += Math.min(inText, 5) + (inSummary ? 3 : 0);
  }
  if (matched > 1) score += matched * 2;                 // sections covering several terms first
  if (terms.length > 1 && phrase && t.includes(phrase)) score += 6;
  return score;
}

/** Up to `limit` short excerpts around the lines that hit the most query terms. */
export function snippetsFor(text, terms, limit = 3) {
  const lines = text.split('\n');
  const scored = [];
  for (const line of lines) {
    const l = line.toLowerCase();
    const hits = terms.filter(t => l.includes(t));
    if (hits.length) scored.push({ line: line.trim(), hits: hits.length, at: l.indexOf(hits[0]) });
  }
  scored.sort((a, b) => b.hits - a.hits);
  return scored.slice(0, limit).map(({ line, at }) => {
    if (line.length <= 260) return line;
    const start = Math.max(0, at - 100);
    return (start ? '…' : '') + line.slice(start, start + 260) + (start + 260 < line.length ? '…' : '');
  });
}

// ── Library ──────────────────────────────────────────────

function expandHome(p) {
  const s = String(p || '').trim();
  return s === '~' ? homedir() : s.startsWith('~/') ? resolve(homedir(), s.slice(2)) : s;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch { return null; }
}

export async function listBooks(root = BOOKS_ROOT) {
  let dirs;
  try { dirs = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const books = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const meta = await readJson(resolve(root, d.name, 'book.json'));
    if (meta?.id === d.name && meta.sourceDir) books.push(meta);
  }
  return books.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export async function getBook(id, root = BOOKS_ROOT) {
  if (!id || !/^[\w-]+$/.test(id)) return null;
  const meta = await readJson(resolve(root, id, 'book.json'));
  return meta?.id === id ? meta : null;
}

/** Where a book's text lives, for messages: the file for a one-file book, else the folder. */
export function bookLocation(book) {
  if (book.pdf) return book.pdf;
  return book.sourceFile ? resolve(book.sourceDir, book.sourceFile) : resolve(book.sourceDir);
}

/**
 * Register a folder — or a single .md / .txt file — as a book. The same folder or file twice
 * returns the existing book. A file book and a folder book over the same directory are distinct.
 */
export async function addBook({ name, path }, root = BOOKS_ROOT) {
  if (!expandHome(path)) throw new Error('A folder or file path is required.');
  const target = resolve(expandHome(path));
  let st;
  try { st = await stat(target); } catch { throw new Error(`Not found: ${target}`); }
  let sourceDir = target;
  let sourceFile = null;
  let files;
  if (st.isFile()) {
    if (/\.epub$/i.test(target)) throw new Error(`${basename(target)} must be converted to markdown first, e.g. pandoc "${target}" -o book.md — then add the .md file.`);
    if (!SOURCE_EXT_RE.test(target)) throw new Error(`Not a book file: ${target} — use a .md, .markdown or .txt file, or a folder of them.`);
    sourceDir = dirname(target);
    sourceFile = basename(target);
    files = [sourceFile];
  } else if (st.isDirectory()) {
    files = await listSourceFiles(sourceDir);
    if (!files.length) throw new Error(`No .md, .markdown or .txt files in ${sourceDir}.`);
  } else {
    throw new Error(`Not a folder or a file: ${target}`);
  }

  const books = await listBooks(root);
  const existing = books.find(b => resolve(b.sourceDir) === sourceDir && (b.sourceFile || null) === sourceFile);
  if (existing) return { book: existing, existed: true, files: files.length };

  const title = String(name || '').trim() || (sourceFile ? sourceFile.replace(SOURCE_EXT_RE, '') : basename(sourceDir));
  let id = slugify(title);
  for (let n = 2; books.some(b => b.id === id); n++) id = `${slugify(title)}-${n}`;
  const book = { id, name: title, sourceDir, ...(sourceFile ? { sourceFile } : {}), createdAt: new Date().toISOString() };
  await mkdir(resolve(root, id, 'index'), { recursive: true });
  await writeFile(resolve(root, id, 'book.json'), JSON.stringify(book, null, 2) + '\n', 'utf-8');
  return { book, existed: false, files: files.length };
}

export const PDF_RE = /\.pdf$/i;

/** The book already made from this PDF, if any. */
export async function findPdfBook(pdfPath, root = BOOKS_ROOT) {
  const abs = resolve(expandHome(pdfPath));
  return (await listBooks(root)).find(b => b.pdf && resolve(b.pdf) === abs) || null;
}

/** Check a PDF path before converting: returns { pdf, title } or throws a message for the user. */
export async function checkPdf(path, name) {
  const pdf = resolve(expandHome(path));
  let st;
  try { st = await stat(pdf); } catch { throw new Error(`Not found: ${pdf}`); }
  if (!st.isFile() || !PDF_RE.test(pdf)) throw new Error(`Not a PDF file: ${pdf}`);
  return { pdf, title: String(name || '').trim() || basename(pdf).replace(PDF_RE, '').replace(/[_]+/g, ' ').trim() };
}

/**
 * Register a book whose markdown was converted from a PDF. The markdown at `mdPath` is moved
 * into the book's own directory (data/books/<id>/source/), so nothing is written next to the PDF.
 */
export async function addConvertedBook({ name, pdf, mdPath }, root = BOOKS_ROOT) {
  const books = await listBooks(root);
  let id = slugify(name);
  for (let n = 2; books.some(b => b.id === id); n++) id = `${slugify(name)}-${n}`;
  const sourceDir = resolve(root, id, 'source');
  const sourceFile = `${slugify(name)}.md`;
  await mkdir(sourceDir, { recursive: true });
  await mkdir(resolve(root, id, 'index'), { recursive: true });
  try { await rename(mdPath, resolve(sourceDir, sourceFile)); }
  catch { await copyFile(mdPath, resolve(sourceDir, sourceFile)); await rm(mdPath, { force: true }); }
  const book = { id, name, sourceDir, sourceFile, pdf: resolve(pdf), createdAt: new Date().toISOString() };
  await writeFile(resolve(root, id, 'book.json'), JSON.stringify(book, null, 2) + '\n', 'utf-8');
  return book;
}

/** Forget a book: deletes its index directory only. The source folder is never touched. */
export async function removeBook(id, root = BOOKS_ROOT) {
  const book = await getBook(id, root);
  if (!book) return false;
  await rm(resolve(root, id), { recursive: true, force: true });
  return true;
}

export async function listSourceFiles(sourceDir) {
  let items;
  try { items = await readdir(sourceDir, { recursive: true, withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const it of items) {
    if (!it.isFile() || !SOURCE_EXT_RE.test(it.name)) continue;
    const rel = relative(sourceDir, resolve(it.parentPath || it.path, it.name)).split(sep).join('/');
    if (rel.split('/').some(seg => seg.startsWith('.') || IGNORE_DIRS.has(seg))) continue;
    out.push(rel);
  }
  // Reading order: "chapter 2" before "chapter 10"
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

// Sections of a file, cached until the file changes (scan, search and the card all need them).
const partsCache = new Map(); // abs path → { mtimeMs, size, parts }
async function fileParts(abs) {
  const st = await stat(abs);
  const hit = partsCache.get(abs);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  const entry = { mtimeMs: st.mtimeMs, size: st.size, parts: splitIntoParts(await readFile(abs, 'utf-8')) };
  partsCache.set(abs, entry);
  return entry;
}

function indexPath(root, book, path, part, total) {
  const suffix = total > 1 ? `.p${String(part).padStart(3, '0')}.idx.md` : '.idx.md';
  return resolve(root, book.id, 'index', path + suffix);
}

function insideDir(dir, abs) {
  const rel = relative(dir, abs);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Every section of the book in reading order, with its index state. */
export async function listSections(book, root = BOOKS_ROOT) {
  const sourceDir = resolve(book.sourceDir);
  const sections = [];
  const files = book.sourceFile ? [book.sourceFile] : await listSourceFiles(sourceDir);
  for (const path of files) {
    let fp;
    try { fp = await fileParts(resolve(sourceDir, path)); } catch { continue; }
    const total = fp.parts.length;
    for (let part = 1; part <= total; part++) {
      const idx = indexPath(root, book, path, part, total);
      let summary = null;
      try { summary = await readFile(idx, 'utf-8'); } catch {}
      const fm = summary ? parseFrontmatter(summary.slice(0, 4096)) : null;
      const ts = fm?.last_updated ? Date.parse(fm.last_updated) : NaN;
      const indexed = !!summary;
      const stale = indexed && (isNaN(ts) || ts < Math.floor(fp.mtimeMs));
      sections.push({
        id: sectionId(path, part, total), path, part, total,
        text: fp.parts[part - 1], mtimeMs: fp.mtimeMs, indexPath: idx,
        summary, indexed, stale,
      });
    }
  }
  return sections;
}

export function summarize(sections) {
  const files = new Set(sections.map(s => s.path)).size;
  const indexed = sections.filter(s => s.indexed && !s.stale).length;
  const stale = sections.filter(s => s.stale).length;
  return { files, sections: sections.length, indexed, stale, unindexed: sections.length - indexed - stale };
}

export async function bookStats(book, root = BOOKS_ROOT) {
  return summarize(await listSections(book, root));
}

function summaryTitle(summary) {
  const m = summary?.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function summaryBody(summary) {
  if (!summary) return '';
  const close = summary.indexOf('\n---', 4);
  return (close === -1 ? summary : summary.slice(close + 4)).trim();
}

/** Table of contents: one line per section, titles from the index where it exists. */
export async function bookContents(book, root = BOOKS_ROOT) {
  const sections = await listSections(book, root);
  const rows = sections.slice(0, MAX_CONTENTS).map(s => {
    const fm = s.summary ? parseFrontmatter(s.summary.slice(0, 4096)) : null;
    return {
      section: s.id,
      title: summaryTitle(s.summary) || titleOf(s.text),
      ...(fm?.tags ? { tags: fm.tags } : {}),
      chars: s.text.length,
      ...(s.indexed ? {} : { indexed: false }),
    };
  });
  return {
    book: book.name, ...summarize(sections), contents: rows,
    ...(sections.length > MAX_CONTENTS ? { note: `Showing the first ${MAX_CONTENTS} of ${sections.length} sections — use search to reach the rest.` } : {}),
  };
}

/** Rank sections by the query's terms over summary + full text; returns the best few with excerpts. */
export async function searchBook(book, query, root = BOOKS_ROOT) {
  const terms = queryTerms(query);
  if (!terms.length) return { error: 'query is required' };
  const phrase = String(query).toLowerCase().trim();
  const sections = await listSections(book, root);
  const ranked = sections
    .map(s => ({ s, score: scoreSection({ text: s.text, summary: summaryBody(s.summary) }, terms, phrase) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const matches = ranked.slice(0, MAX_SEARCH_HITS).map(({ s, score }) => ({
    section: s.id,
    title: summaryTitle(s.summary) || titleOf(s.text),
    score,
    snippets: snippetsFor(s.text, terms),
  }));
  return {
    book: book.name, query, terms, matches,
    ...(ranked.length > matches.length ? { more: ranked.length - matches.length } : {}),
    ...(matches.length ? {} : { note: `Nothing in "${book.name}" mentions ${terms.map(t => `"${t}"`).join(', ')}. Try other keywords before concluding the book does not cover it.` }),
  };
}

/** One section's full text, with its summary and neighbours. */
export async function readSection(book, id, root = BOOKS_ROOT) {
  const { path, part } = parseSectionId(id);
  if (!path) return { error: 'section is required (see book_read contents or search)' };
  const sourceDir = resolve(book.sourceDir);
  const abs = resolve(sourceDir, path);
  if (!insideDir(sourceDir, abs)) return { error: 'Section path is outside the book.' };
  if (!SOURCE_EXT_RE.test(abs)) return { error: 'Not a book file (.md, .markdown, .txt).' };
  if (book.sourceFile && path !== book.sourceFile) return { error: `"${book.name}" is the single file ${book.sourceFile}; ${path} is not part of it.` };
  const all = await listSections(book, root);
  const sections = all.filter(s => s.path === path);
  if (!sections.length) return { error: `No such file in "${book.name}": ${path}` };
  const sec = sections[part - 1];
  if (!sec) return { error: `${path} has ${sections.length} section(s); "#${part}" does not exist.` };
  const i = all.indexOf(sec);
  return {
    book: book.name, section: sec.id, part: sec.part, of: sec.total,
    ...(i > 0 ? { previous: all[i - 1].id } : {}),
    ...(i < all.length - 1 ? { next: all[i + 1].id } : {}),
    text: sec.text,
  };
}

/**
 * Write the index entry for one section. `summarizeFn({ book, section, title, text })` is the LLM
 * call and must return the entry text starting with frontmatter. Up-to-date entries are skipped
 * unless `force`; stale ones are rebuilt.
 */
export async function indexSection(book, sec, summarizeFn, { force = false } = {}) {
  if (sec.indexed && !sec.stale && !force) return { skipped: true, section: sec.id };
  const raw = await summarizeFn({ book, section: sec.id, title: titleOf(sec.text), text: sec.text });
  const summary = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^```(?:markdown)?\n([\s\S]*?)\n```\s*$/, '$1').trim();
  if (!summary.startsWith('---')) throw new Error(`summary for ${sec.id} has no frontmatter`);
  const patched = enforceFrontmatterFields(summary, {
    source: `book:${book.id}/${sec.id}`,
    last_updated: new Date(sec.mtimeMs).toISOString(),
  });
  await mkdir(dirname(sec.indexPath), { recursive: true });
  const tmp = sec.indexPath + '.tmp';
  await writeFile(tmp, patched, 'utf-8');
  await rename(tmp, sec.indexPath);
  return { ok: true, section: sec.id, chars: patched.length };
}
