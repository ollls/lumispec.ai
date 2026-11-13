// Books plugin — index a folder as a book, open it, chat against it. See docs/BOOKS.md.
//
// A book is a folder of .md / .txt files anywhere on disk. Its index (one LLM-written summary per
// section) lives in the app's own data/books/<id>/ directory; the folder is never modified.
// One book is "open" at a time (saved as `activeBook` in data/plugins.json): `book_read` can see
// only that book, and the system prompt tells the model to consult it before anything else.
// With "Book only" on, every tool outside this plugin and `core` is withheld while a book is open
// (the `exclusive` hook, enforced by getSystemPrompt() and executeTool() in ./index.js).
//
// Indexing runs in the background on the server, section by section, started from the card, on
// adding a book, or by `book_library { action: "index" }`. It resumes where it stopped: sections
// already indexed and unchanged are skipped.

import { readPluginConfig, updatePluginConfig } from './index.js';
import { collectChatCompletion } from '../services/llm.js';
import * as books from '../services/books.js';

const GROUP = 'books';
export const DEFAULTS = {
  enabled: false,
  activeBook: '',   // id of the open book, '' = none
  bookOnly: false,  // while a book is open, withhold every other plugin's tools
  addFolder: '',    // card text field: consumed by configChanged(), never stays saved
};
const MAX_CONSECUTIVE_FAILURES = 3;

// ── Cached state (prompt/routing/cardStatus/exclusive are synchronous) ──

const cache = { cfg: { ...DEFAULTS }, books: [], stats: new Map() };

async function refresh() {
  const saved = (await readPluginConfig())[GROUP] || {};
  cache.cfg = { ...DEFAULTS, ...saved };
  cache.books = await books.listBooks();
  const stats = new Map();
  for (const b of cache.books) {
    try { stats.set(b.id, await books.bookStats(b)); } catch { /* folder gone: no stats */ }
  }
  cache.stats = stats;
}

function activeBook() {
  return cache.books.find(b => b.id === cache.cfg.activeBook) || null;
}

async function setActive(id) {
  await updatePluginConfig(GROUP, { config: { activeBook: id || '' } });
  await refresh();
}

// ── Background indexing ──────────────────────────────────

const jobs = new Map(); // book id → { running, done, total, failed, lastError, stop }

// One line in the Books prompt so "convert this PDF and add it" works; left out under Book only,
// where run_python is withheld.
const PDF_LINE = '- A PDF is not a book yet. When the user asks to add one, convert it with run_python — `import pymupdf4llm; md = pymupdf4llm.to_markdown(pdf_path)` — write the result as a .md file next to the PDF, then call book_library with action "add" and that file\'s path. Scanned PDFs come out nearly empty: say so instead of adding an empty book.';

const INDEX_SYSTEM = `You write compact INDEX entries for sections of a book. Each entry lets a reader decide, without opening the section, whether it answers their question.
Output EXACTLY this format and nothing else — no preamble, no code fence:

---
source: <filled in by the system>
last_updated: <filled in by the system>
tags: [tag1, tag2, tag3]
answers:
  - "question this section answers"
  - "another question"
---
# {short title of the section}

{One dense paragraph (3-6 sentences): what this section covers and the most important concrete facts, names, terms, events or arguments in it.}

## Key topics
- topic one — one-line note
- topic two — one-line note

Rules:
- The section text is the ONLY source. Do not add anything from your own knowledge of this book, its author or its subject, and do not explain what the text leaves unexplained.
- Cover the WHOLE section. A section often opens with the end of the previous chapter (closing paragraphs, exercises, quiz answers) before its first heading: mention that material in the paragraph and give it a key topic, even when the title names the chapter that follows.
- Names, numbers, dates and terms must appear in the text exactly as you write them.
- 5-8 tags, lowercase, hyphenated, specific to this section, in the text's own vocabulary.
- 3-6 "answers" phrased as questions a reader might ask that this section really answers.
- 3-8 key topics. Do not reproduce long passages, tables or code — this is an index, not a copy.
- If the section is front matter, a table of contents, or has no real content, say so in one sentence and leave Key topics empty.`;

async function summarizeSection({ book, section, title, text }) {
  const { content } = await collectChatCompletion([
    { role: 'system', content: INDEX_SYSTEM },
    { role: 'user', content: `Book: ${book.name}\nSection: ${section}\nFirst heading or line: ${title}\nLength: ${text.length} chars\n\n\`\`\`\n${text}\n\`\`\`` },
  ], { signal: AbortSignal.timeout(120000), maxTokens: 1200, temperature: 0.1 });
  return content || '';
}

function jobView(job) {
  if (!job) return null;
  const { running, done, total, failed, lastError } = job;
  return { running, done, total, ...(failed ? { failed } : {}), ...(lastError ? { lastError } : {}) };
}

/** Start (or report) the background index run for one book. Returns the job at once. */
export async function startIndexing(book, { force = false, summarizeFn = summarizeSection } = {}) {
  const existing = jobs.get(book.id);
  if (existing?.running) return existing;
  const sections = await books.listSections(book);
  const todo = force ? sections : sections.filter(s => !s.indexed || s.stale);
  const job = { running: todo.length > 0, done: 0, total: todo.length, failed: 0, lastError: null, stop: false };
  jobs.set(book.id, job);
  if (!todo.length) return job;
  job.promise = (async () => {
    let streak = 0;
    for (const sec of todo) {
      if (job.stop) break;
      try {
        await books.indexSection(book, sec, summarizeFn, { force: true });
        job.done++;
        streak = 0;
      } catch (err) {
        job.failed++;
        job.lastError = err.message;
        console.warn(`[books] index ${book.id}/${sec.id} failed: ${err.message}`);
        if (++streak >= MAX_CONSECUTIVE_FAILURES) {
          job.lastError = `stopped after ${streak} failures in a row — ${err.message}`;
          break;
        }
      }
    }
    job.running = false;
    console.log(`[books] "${book.name}": indexed ${job.done}/${job.total}${job.failed ? `, ${job.failed} failed` : ''}`);
    try { await refresh(); } catch {}
  })();
  return job;
}

// ── Prompt (built from the cache; changes only when the open book or its counts change) ──

function statsLine(st) {
  if (!st) return 'folder not readable';
  const todo = st.unindexed + st.stale;
  return `${st.sections} section${st.sections === 1 ? '' : 's'} in ${st.files} file${st.files === 1 ? '' : 's'}, ${st.indexed} indexed${todo ? `, ${todo} to index` : ''}`;
}

export function booksPrompt({ book, stats, bookOnly, libraryCount }) {
  if (!book) {
    return `## Books
No book is open. The user's library holds ${libraryCount} book${libraryCount === 1 ? '' : 's'}. When the user asks to list, add, open, index or close a book, call "book_library". "book_read" works only while a book is open.
${PDF_LINE}`;
  }
  const unindexed = stats ? stats.unindexed + stats.stale : 0;
  const outside = bookOnly
    ? '- If the book does not cover the question, say so plainly and stop. Do not answer from general knowledge: "Book only" is on and the other tools are withheld.'
    : '- If the book does not cover the question, say so plainly first. You may then use other tools or general knowledge, clearly marked as NOT from the book.';
  return `## Books — open book: "${book.name}"
The user has opened the book "${book.name}"${stats ? ` (${stats.sections} sections)` : ''}. It is the PRIMARY source for this conversation.
- For any question the book could cover, consult it BEFORE any other tool: "book_read" with action "search" and a few keywords from the question, then action "read" on the best 1-3 sections. Search results are excerpts, not the text — read a section before quoting or summarizing it.
- For "what is this book about" or an overview, use action "contents".
- Name the section(s) an answer rests on, e.g. (ch03.md#2). Quote exactly and sparingly.
- Never state that the book says something you did not see in a book_read result of this conversation.
${outside}${unindexed ? `\n- ${unindexed} section(s) have no summary yet; search still covers their full text. Indexing: book_library action "index".` : ''}
- Library management (list, add, open another book, close, index) goes through "book_library".${bookOnly ? '' : `\n${PDF_LINE}`}`;
}

function livePrompt() {
  refresh().catch(() => {}); // keep the cache warm for the next build (card edits, new files)
  const book = activeBook();
  return booksPrompt({ book, stats: book ? cache.stats.get(book.id) : null, bookOnly: cache.cfg.bookOnly, libraryCount: cache.books.length });
}

// ── Tool helpers ─────────────────────────────────────────

function libraryRows() {
  return cache.books.map(b => ({
    name: b.name, id: b.id, source: books.bookLocation(b), open: b.id === cache.cfg.activeBook,
    ...(cache.stats.get(b.id) || { error: 'folder not readable' }),
    ...(jobs.get(b.id)?.running ? { indexing: jobView(jobs.get(b.id)) } : {}),
  }));
}

function libraryMarkdown(rows) {
  if (!rows.length) return '**Books** — the library is empty. Add a folder of `.md` / `.txt` files to start.';
  const lines = rows.map(r => `| ${r.open ? '**▶**' : ''} | ${r.name.replace(/\|/g, '\\|')} | ${r.sections ?? '—'} | ${r.indexed ?? '—'} | ${r.indexing ? `indexing ${r.indexing.done}/${r.indexing.total}` : ((r.unindexed || 0) + (r.stale || 0) ? `${(r.unindexed || 0) + (r.stale || 0)} to index` : 'ready')} | \`${r.source}\` |`);
  return `**Books**\n\n| Open | Book | Sections | Indexed | Status | Source |\n|---|---|---|---|---|---|\n${lines.join('\n')}`;
}

function pick(spec) {
  if (spec == null || String(spec).trim() === '') {
    const book = activeBook();
    return book ? { book } : { error: 'No book is open and none was named.', candidates: cache.books.map(b => b.name) };
  }
  return books.resolveBook(spec, cache.books);
}

async function confirm(context, text) {
  if (typeof context?.confirmFn !== 'function') return { error: 'This needs the user\'s approval, and no approval prompt is available in this context.' };
  const ok = await context.confirmFn(text);
  return ok ? null : { error: 'The user declined.' };
}

// ── Plugin ───────────────────────────────────────────────

await refresh().catch(() => {});

export default {
  group: GROUP,
  label: 'Books',
  description: 'My Books: index a folder of markdown / text files as a book, open it and chat against it. The open book is the assistant\'s first source; "Book only" withholds every other tool. Each book\'s index lives in its own directory under data/books/ — the folder itself is never modified.',
  defaults: DEFAULTS,
  beforeCard: refresh,
  // While true, getSystemPrompt() lists only this plugin's tools (plus core) and executeTool()
  // refuses the rest.
  exclusive: () => !!(cache.cfg.bookOnly && activeBook()),

  configUi: () => ({
    fields: [
      {
        key: 'activeBook', label: 'Open book', type: 'select',
        options: [
          { value: '', label: cache.books.length ? 'None' : 'None (library is empty)' },
          ...cache.books.map(b => ({ value: b.id, label: `${b.name} — ${statsLine(cache.stats.get(b.id))}` })),
        ],
        note: 'The assistant consults the open book before anything else. One book at a time, for every conversation.',
      },
      {
        key: 'bookOnly', label: 'Book only', type: 'boolean',
        note: 'While a book is open, withhold web search, Python and every other plugin\'s tools, and have the assistant say "not in this book" instead of answering from elsewhere.',
      },
      {
        key: 'addFolder', label: 'Add a book', type: 'text', placeholder: '/path/to/folder or file.md  (Enter)',
        note: 'A folder of .md / .txt files, or one such file, anywhere on disk. It is opened and indexed right away; the index is stored under data/books/ and your files are never modified. Have a PDF? Ask the assistant in chat: "convert ~/Books/book.pdf to markdown and add it to my books" (with Book only off).',
      },
    ],
  }),

  // Called by updatePluginConfig() with the merged entry before it is saved; may edit it.
  configChanged: async (current, changed) => {
    const out = {};
    if (typeof changed.addFolder === 'string' && changed.addFolder.trim()) {
      try {
        const { book, existed, files } = await books.addBook({ path: changed.addFolder });
        current.activeBook = book.id;
        const job = await startIndexing(book);
        out.notice = existed
          ? `"${book.name}" is already in the library — opened.`
          : `Added and opened "${book.name}" (${files} file${files === 1 ? '' : 's'}). Indexing ${job.total} section${job.total === 1 ? '' : 's'} in the background.`;
      } catch (err) {
        out.warning = err.message;
      }
    }
    current.addFolder = '';
    if (current.activeBook && !(await books.getBook(current.activeBook))) current.activeBook = '';
    cache.cfg = { ...DEFAULTS, ...current };
    cache.books = await books.listBooks();
    return out;
  },

  cardStatus: () => {
    const book = activeBook();
    const only = cache.cfg.bookOnly && book ? ' · Book only' : '';
    const running = [...jobs.entries()].find(([, j]) => j.running);
    if (running) {
      const name = cache.books.find(b => b.id === running[0])?.name || running[0];
      return { ok: true, text: `Indexing "${name}": ${running[1].done}/${running[1].total} sections…${book ? ` · Open: ${book.name}` : ''}${only}` };
    }
    if (!cache.books.length) return { ok: false, text: 'No books yet — add a folder below' };
    if (!book) return { ok: true, text: `No book open · ${cache.books.length} in the library` };
    const st = cache.stats.get(book.id);
    const failed = jobs.get(book.id)?.lastError;
    const todo = st ? st.unindexed + st.stale : 0;
    return { ok: !!st && !todo, text: `Open: ${book.name} — ${statsLine(st)}${failed && todo ? ` · last run: ${failed}` : ''}${only}` };
  },

  cardActions: () => {
    const book = activeBook();
    if (!book) return null;
    const job = jobs.get(book.id);
    if (job?.running) return { buttons: [{ id: 'stop', label: 'Stop indexing' }] };
    const st = cache.stats.get(book.id);
    const todo = st ? st.unindexed + st.stale : 0;
    if (!todo) return null;
    return { buttons: [{ id: 'index', label: `Index ${todo} section${todo === 1 ? '' : 's'}`, title: 'Runs in the background on the active LLM, one section at a time' }] };
  },

  cardAction: async (id) => {
    await refresh();
    const book = activeBook();
    if (!book) return { error: 'No book is open.' };
    if (id === 'stop') {
      const job = jobs.get(book.id);
      if (job?.running) job.stop = true;
      return { ok: true, message: 'Indexing stops after the current section.' };
    }
    const job = await startIndexing(book);
    return { ok: true, message: job.total ? `Indexing ${job.total} section(s) of "${book.name}" in the background.` : `"${book.name}" is fully indexed.` };
  },

  routing: () => (activeBook()
    ? [
      `- ANY question while the book "${activeBook().name}" is open → "book_read" (search, then read) before any other tool`,
      '- Open / add / list / index / close a book → "book_library"',
    ]
    : ['- Open / add / list / index a book ("my books") → "book_library"']),
  prompt: livePrompt,

  tools: {
    book_library: {
      description: `Manage the user's book library. A book is a folder of .md/.txt files with its own index; one book is open at a time.
Actions:
- "list": every book with section and index counts, and which one is open.
- "open": make a book the open one. book = name, id or a unique part of the name.
- "close": no book open.
- "add": register a folder of .md/.txt files, or one such file, as a book, open it and start indexing. path = folder or file (required), name = title (optional, default: folder or file name). Asks the user to approve.
- "index": index the open book (or "book") in the background; only new or changed sections. force: true rebuilds everything. Returns at once — report the counts, do not wait or poll.
- "status": index progress of the open book (or "book").
- "stop": stop a running index.
- "remove": forget a book (deletes its index, never the folder). Asks the user to approve.`,
      parameters: {
        action: 'string (list | open | close | add | index | status | stop | remove)',
        book: 'string (optional: book name, id or part of the name; default = the open book)',
        path: 'string (add only: folder or file path)',
        name: 'string (add only, optional: title)',
        force: 'boolean (index only, optional: rebuild every section)',
      },
      execute: async ({ action = 'list', book: spec, path, name, force = false } = {}, context) => {
        await refresh();
        switch (String(action).toLowerCase()) {
          case 'list': {
            const rows = libraryRows();
            return { books: rows, open: activeBook()?.name || null, bookOnly: cache.cfg.bookOnly, _markdown: libraryMarkdown(rows) };
          }
          case 'open': {
            const r = pick(spec ?? name);
            if (r.error) return r;
            await setActive(r.book.id);
            const st = cache.stats.get(r.book.id);
            return {
              ok: true, open: r.book.name, ...(st || {}),
              note: `"${r.book.name}" is now the open book. Answer questions about it with book_read (search → read).${st && st.unindexed + st.stale ? ` ${st.unindexed + st.stale} section(s) are not indexed yet — offer to index (book_library action "index").` : ''}`,
            };
          }
          case 'close': {
            const was = activeBook()?.name || null;
            await setActive('');
            return { ok: true, closed: was, note: was ? `"${was}" is closed. No book is open.` : 'No book was open.' };
          }
          case 'add': {
            if (!path?.trim()) return { error: 'path is required: a folder of .md / .txt files, or one such file.' };
            const denied = await confirm(context, `Add ${path} to Books${name ? ` as "${name}"` : ''}, open it and index it`);
            if (denied) return denied;
            let added;
            try { added = await books.addBook({ name, path }); } catch (err) { return { error: err.message }; }
            await setActive(added.book.id);
            const job = await startIndexing(added.book);
            return {
              ok: true, book: added.book.name, id: added.book.id, source: books.bookLocation(added.book), files: added.files,
              ...(added.existed ? { note: 'This was already a book; it is now open.' } : {}),
              indexing: jobView(job),
              message: job.total ? `Indexing ${job.total} section(s) in the background. The book can be searched and read meanwhile; summaries appear as they are written.` : 'Already fully indexed.',
            };
          }
          case 'index': {
            const r = pick(spec);
            if (r.error) return r;
            const job = await startIndexing(r.book, { force: !!force });
            return {
              book: r.book.name, indexing: jobView(job),
              message: job.total ? `Indexing ${job.total} section(s) in the background (${job.done} done so far). Tell the user; progress shows on the Books card and via action "status".` : 'Every section is indexed and up to date.',
            };
          }
          case 'status': {
            const r = pick(spec);
            if (r.error) return r;
            return { book: r.book.name, open: r.book.id === cache.cfg.activeBook, ...(cache.stats.get(r.book.id) || {}), indexing: jobView(jobs.get(r.book.id)) };
          }
          case 'stop': {
            const r = pick(spec);
            if (r.error) return r;
            const job = jobs.get(r.book.id);
            if (!job?.running) return { book: r.book.name, note: 'No index run is in progress.' };
            job.stop = true;
            return { ok: true, book: r.book.name, note: 'Indexing stops after the current section.', indexing: jobView(job) };
          }
          case 'remove': {
            const r = spec ? books.resolveBook(spec, cache.books) : { error: 'Name the book to remove.', candidates: cache.books.map(b => b.name) };
            if (r.error) return r;
            const denied = await confirm(context, `Remove the book "${r.book.name}" from Books (deletes its index; ${books.bookLocation(r.book)} is kept)`);
            if (denied) return denied;
            const job = jobs.get(r.book.id);
            if (job?.running) { job.stop = true; await job.promise; }
            if (r.book.id === cache.cfg.activeBook) await setActive('');
            await books.removeBook(r.book.id);
            jobs.delete(r.book.id);
            await refresh();
            return { ok: true, removed: r.book.name, note: 'Index deleted. The source files were not touched.' };
          }
          default:
            return { error: `Unknown action "${action}". Use list, open, close, add, index, status, stop or remove.` };
        }
      },
    },

    book_read: {
      description: `Read the OPEN book — the only book this tool can see.
Actions:
- "search": rank the book's sections for a question. query = a few keywords (not a sentence). Returns the best sections with short excerpts.
- "read": the full text of one section. section = an id from search or contents, e.g. "ch03.md" or "book.txt#12". The result names the previous / next section.
- "contents": the table of contents — every section with its title and tags.`,
      parameters: {
        action: 'string (search | read | contents)',
        query: 'string (search: keywords)',
        section: 'string (read: section id)',
      },
      execute: async ({ action, query, section } = {}) => {
        await refresh();
        const book = activeBook();
        if (!book) {
          return {
            error: 'No book is open.',
            library: cache.books.map(b => b.name),
            hint: cache.books.length ? 'Open one with book_library {"action":"open","book":"…"} — ask the user which if it is not obvious.' : 'The library is empty. The user can add a folder on the Books card or ask you to add one (book_library action "add").',
          };
        }
        const act = String(action || (section ? 'read' : query ? 'search' : 'contents')).toLowerCase();
        try {
          if (act === 'search') return await books.searchBook(book, query);
          if (act === 'read') return await books.readSection(book, section);
          if (act === 'contents') return await books.bookContents(book);
        } catch (err) {
          return { error: `Could not read "${book.name}" (${books.bookLocation(book)}): ${err.message}` };
        }
        return { error: `Unknown action "${action}". Use search, read or contents.` };
      },
    },
  },
};
