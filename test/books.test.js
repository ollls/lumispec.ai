import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, utimes, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  splitIntoParts, sectionId, parseSectionId, titleOf, slugify, resolveBook, queryTerms,
  addBook, listBooks, getBook, removeBook, listSourceFiles, listSections, summarize,
  indexSection, searchBook, readSection, bookContents,
} from '../src/services/books.js';
import { booksPrompt, addPdf } from '../src/tools/plugin-books.js';
import { parseProgressLine } from '../src/services/pdfToMarkdown.js';
import { checkPdf, findPdfBook } from '../src/services/books.js';

// Books: a folder of md/txt files indexed into its own directory, one book open at a time.
// Everything below runs against temp directories with a fake summarizer — no llama needed.

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'books-test-'));
  const src = join(dir, 'moby');
  const root = join(dir, 'library');
  await mkdir(join(src, 'part 2'), { recursive: true });
  await mkdir(join(src, '.obsidian'), { recursive: true });
  await writeFile(join(src, 'chapter 1.md'), '# Loomings\n\nCall me Ishmael. Some years ago I went to sea as a sailor.\n');
  await writeFile(join(src, 'chapter 2.md'), '# The Carpet-Bag\n\nI stuffed a shirt or two into my old carpet-bag and started for Cape Horn.\n');
  await writeFile(join(src, 'chapter 10.md'), '# A Bosom Friend\n\nQueequeg the harpooneer sat by the fire with his tomahawk pipe.\n');
  await writeFile(join(src, 'part 2', 'whales.txt'), 'CETOLOGY\n\n' + 'The sperm whale is the largest toothed whale. '.repeat(900));
  await writeFile(join(src, '.obsidian', 'app.md'), 'not part of the book');
  await writeFile(join(src, 'cover.png'), 'x');
  return { dir, src, root };
}

const fakeSummary = async ({ section, title }) => `---\nsource: wrong\ntags: [whales]\n---\n# ${title} (summary)\n\nAbout ${section}. Mentions ambergris.\n\n## Key topics\n- one — note\n`;

test('splitIntoParts: short text is one part; long text splits on paragraphs and rejoins exactly', () => {
  assert.deepEqual(splitIntoParts('hello'), ['hello']);
  const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ` + 'word '.repeat(60)).join('\n\n');
  const parts = splitIntoParts(text, 2000);
  assert.ok(parts.length > 5);
  assert.equal(parts.join(''), text);
  assert.ok(parts.every(p => p.length <= 2000));
  assert.ok(parts.slice(1).every(p => p.startsWith('Paragraph')), 'breaks fall on paragraph starts');
});

test('splitIntoParts: a heading starts a new section once the current one is half full; huge paragraphs are cut', () => {
  const text = 'intro '.repeat(120) + '\n\n# Chapter Two\n\n' + 'body '.repeat(100);
  const parts = splitIntoParts(text, 1000);
  assert.ok(parts[1].startsWith('# Chapter Two'));
  const blob = 'x'.repeat(2500);
  const cut = splitIntoParts(blob, 1000);
  assert.deepEqual(cut.map(p => p.length), [1000, 1000, 500]);
  assert.equal(cut.join(''), blob);
});

test('section ids: bare path for one-part files, #n otherwise', () => {
  assert.equal(sectionId('a/b.md', 1, 1), 'a/b.md');
  assert.equal(sectionId('book.txt', 12, 30), 'book.txt#12');
  assert.deepEqual(parseSectionId('book.txt#12'), { path: 'book.txt', part: 12 });
  assert.deepEqual(parseSectionId('./ch 1.md'), { path: 'ch 1.md', part: 1 });
  assert.equal(titleOf('\n\n## **The** Whale ##\ntext'), 'The Whale');
  assert.equal(titleOf('plain first line\nmore'), 'plain first line');
  assert.equal(slugify('Moby-Dick; or, The Whale!'), 'moby-dick-or-the-whale');
});

test('resolveBook: id, exact name, unique fragment; several matches ask', () => {
  const lib = [{ id: 'sicp', name: 'SICP' }, { id: 'moby-dick', name: 'Moby Dick' }, { id: 'moby-notes', name: 'Moby notes' }];
  assert.equal(resolveBook('sicp', lib).book.id, 'sicp');
  assert.equal(resolveBook('moby dick', lib).book.id, 'moby-dick');
  assert.equal(resolveBook('notes', lib).book.id, 'moby-notes');
  const many = resolveBook('moby', lib);
  assert.match(many.error, /matches 2 books/);
  assert.deepEqual(many.candidates, ['Moby Dick', 'Moby notes']);
  assert.match(resolveBook('dune', lib).error, /No book matches/);
  assert.match(resolveBook('', lib).error, /No book named/);
});

test('queryTerms drops stopwords and short words, falls back to the whole query', () => {
  assert.deepEqual(queryTerms('What does the whale eat?'), ['whale', 'eat']);
  assert.deepEqual(queryTerms('to be'), ['to be']);
});

test('library: add, list, same folder twice, bad paths, remove keeps the folder', async () => {
  const { dir, src, root } = await fixture();
  try {
    assert.deepEqual(await listBooks(root), []);
    const { book, existed, files } = await addBook({ path: src }, root);
    assert.equal(book.name, 'moby');
    assert.equal(existed, false);
    assert.equal(files, 4);
    const again = await addBook({ name: 'Other title', path: src + '/' }, root);
    assert.equal(again.existed, true);
    assert.equal(again.book.id, book.id);
    assert.equal((await listBooks(root)).length, 1);
    assert.equal((await getBook(book.id, root)).sourceDir, src);
    assert.equal(await getBook('../etc', root), null);
    await assert.rejects(addBook({ path: join(dir, 'nope') }, root), /Not found/);
    await assert.rejects(addBook({ path: join(src, 'cover.png') }, root), /Not a book file/);
    await writeFile(join(dir, 'novel.epub'), 'x');
    await assert.rejects(addBook({ path: join(dir, 'novel.epub') }, root), /novel\.epub must be converted to markdown first/);
    await mkdir(join(dir, 'empty'));
    await assert.rejects(addBook({ path: join(dir, 'empty') }, root), /No \.md/);

    assert.equal(await removeBook(book.id, root), true);
    assert.deepEqual(await listBooks(root), []);
    assert.equal((await readdir(src)).includes('chapter 1.md'), true, 'source folder untouched');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source files: md/txt only, hidden folders skipped, natural reading order', async () => {
  const { dir, src } = await fixture();
  try {
    assert.deepEqual(await listSourceFiles(src), ['chapter 1.md', 'chapter 2.md', 'chapter 10.md', 'part 2/whales.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('index: sections, summaries written under the library, stale after an edit, resume skips done ones', async () => {
  const { dir, src, root } = await fixture();
  try {
    const { book } = await addBook({ name: 'Moby Dick', path: src }, root);
    let sections = await listSections(book, root);
    const whales = sections.filter(s => s.path === 'part 2/whales.txt');
    assert.ok(whales.length >= 3, 'the long file is split');
    assert.equal(whales[1].id, 'part 2/whales.txt#2');
    assert.deepEqual(summarize(sections), { files: 4, sections: sections.length, indexed: 0, stale: 0, unindexed: sections.length });

    let calls = 0;
    const fn = async (a) => { calls++; return fakeSummary(a); };
    for (const s of sections) await indexSection(book, s, fn);
    assert.equal(calls, sections.length);

    sections = await listSections(book, root);
    assert.equal(summarize(sections).indexed, sections.length);
    const entry = await readFile(join(root, book.id, 'index', 'chapter 1.md.idx.md'), 'utf-8');
    assert.match(entry, /^---\nsource: book:moby-dick\/chapter 1\.md\nlast_updated: \d{4}-/);
    assert.ok(!entry.includes('source: wrong'), 'source is enforced, not taken from the model');
    assert.ok(sections.every(s => s.indexPath.startsWith(join(root, book.id, 'index'))));
    assert.deepEqual((await readdir(src)).sort(), ['.obsidian', 'chapter 1.md', 'chapter 10.md', 'chapter 2.md', 'cover.png', 'part 2'], 'nothing written into the book folder');

    // second pass: nothing to do
    for (const s of sections) assert.equal((await indexSection(book, s, fn)).skipped, true);
    assert.equal(calls, sections.length);

    // edit one chapter → only it is stale, and it is rebuilt without force
    const future = new Date(Date.now() + 60_000);
    await writeFile(join(src, 'chapter 2.md'), '# The Carpet-Bag\n\nRewritten.\n');
    await utimes(join(src, 'chapter 2.md'), future, future);
    sections = await listSections(book, root);
    assert.deepEqual(sections.filter(s => s.stale).map(s => s.id), ['chapter 2.md']);
    for (const s of sections) await indexSection(book, s, fn);
    assert.equal(calls, sections.length + 1);
    assert.equal(summarize(await listSections(book, root)).stale, 0);

    await assert.rejects(indexSection(book, sections[0], async () => 'Sure! Here is the summary', { force: true }), /no frontmatter/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('search ranks by text and summary; read returns one section with neighbours; contents lists all', async () => {
  const { dir, src, root } = await fixture();
  try {
    const { book } = await addBook({ name: 'Moby Dick', path: src }, root);

    // unindexed books are searchable through their text
    const q = await searchBook(book, 'Who is Queequeg the harpooneer?', root);
    assert.equal(q.matches[0].section, 'chapter 10.md');
    assert.equal(q.matches[0].title, 'A Bosom Friend');
    assert.match(q.matches[0].snippets[0], /Queequeg the harpooneer/);

    const none = await searchBook(book, 'spaceship', root);
    assert.deepEqual(none.matches, []);
    assert.match(none.note, /Nothing in "Moby Dick"/);

    // summary text is searched too once a section is indexed
    const sections = await listSections(book, root);
    await indexSection(book, sections[0], fakeSummary);
    const viaSummary = await searchBook(book, 'ambergris', root);
    assert.deepEqual(viaSummary.matches.map(m => m.section), ['chapter 1.md']);
    assert.equal(viaSummary.matches[0].title, 'Loomings (summary)');

    const r = await readSection(book, 'chapter 2.md', root);
    assert.match(r.text, /carpet-bag/);
    assert.equal(r.previous, 'chapter 1.md');
    assert.equal(r.next, 'chapter 10.md');
    const part = await readSection(book, 'part 2/whales.txt#2', root);
    assert.equal(part.part, 2);
    assert.ok(part.text.length <= 16000);
    assert.match((await readSection(book, 'part 2/whales.txt#99', root)).error, /does not exist/);
    assert.match((await readSection(book, '../../etc/passwd', root)).error, /outside the book/);
    assert.match((await readSection(book, 'cover.png', root)).error, /Not a book file/);
    assert.match((await readSection(book, 'missing.md', root)).error, /No such file/);

    const toc = await bookContents(book, root);
    assert.equal(toc.contents.length, sections.length);
    assert.deepEqual(toc.contents[0], { section: 'chapter 1.md', title: 'Loomings (summary)', tags: '[whales]', chars: sections[0].text.length });
    assert.equal(toc.contents[1].indexed, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('prompt: no book → library line; open book → book first; Book only forbids outside answers', () => {
  const none = booksPrompt({ book: null, libraryCount: 2 });
  assert.match(none, /No book is open\. The user's library holds 2 books/);
  const stats = { files: 3, sections: 12, indexed: 10, stale: 1, unindexed: 1 };
  const open = booksPrompt({ book: { name: 'SICP' }, stats, bookOnly: false, libraryCount: 2 });
  assert.match(open, /open book: "SICP"/);
  assert.match(open, /BEFORE any other tool/);
  assert.match(open, /clearly marked as NOT from the book/);
  assert.match(open, /2 section\(s\) have no summary yet/);
  const only = booksPrompt({ book: { name: 'SICP' }, stats: { ...stats, indexed: 12, stale: 0, unindexed: 0 }, bookOnly: true, libraryCount: 2 });
  assert.match(only, /say so plainly and stop/);
  assert.ok(!only.includes('NOT from the book'));
  assert.ok(!only.includes('no summary yet'));
});

test('a single file as a book: only that file, named after it, distinct from the folder book', async () => {
  const { dir, src, root } = await fixture();
  try {
    const file = join(src, 'part 2', 'whales.txt');
    const { book, existed, files } = await addBook({ path: file }, root);
    assert.equal(book.name, 'whales');
    assert.equal(book.sourceFile, 'whales.txt');
    assert.equal(book.sourceDir, join(src, 'part 2'));
    assert.deepEqual([existed, files], [false, 1]);
    assert.equal((await addBook({ path: file }, root)).existed, true);

    // a sibling file is not part of the book
    await writeFile(join(src, 'part 2', 'notes.md'), '# Notes\n\nQueequeg again.\n');
    const sections = await listSections(book, root);
    assert.ok(sections.length >= 3);
    assert.ok(sections.every(s => s.path === 'whales.txt'));
    assert.equal(sections[1].id, 'whales.txt#2');
    assert.deepEqual((await searchBook(book, 'Queequeg', root)).matches, []);
    assert.match((await readSection(book, 'notes.md', root)).error, /not part of it/);
    assert.match((await readSection(book, 'whales.txt#1', root)).text, /^CETOLOGY/);

    // the folder that holds it is a different book
    const folder = await addBook({ path: join(src, 'part 2') }, root);
    assert.equal(folder.existed, false);
    assert.notEqual(folder.book.id, book.id);
    assert.equal((await listBooks(root)).length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('converter protocol lines parse; anything else is ignored', () => {
  assert.deepEqual(parseProgressLine('PAGES 690'), { type: 'pages', total: 690 });
  assert.deepEqual(parseProgressLine('PROGRESS 120 690'), { type: 'progress', done: 120, total: 690 });
  assert.deepEqual(parseProgressLine('DONE 1191544 445 761'), { type: 'done', chars: 1191544, headings: 445, codeBlocks: 761 });
  assert.deepEqual(parseProgressLine('ERROR the PDF is password-protected'), { type: 'error', message: 'the PDF is password-protected' });
  assert.equal(parseProgressLine('MuPDF warning: something'), null);
});

test('PDF book: step 1 converts into the library, step 2 indexes; the same PDF twice is one book', async () => {
  const { dir, root } = await fixture();
  try {
    const pdf = join(dir, 'Math_for_Programmers.pdf');
    await writeFile(pdf, '%PDF-1.7');
    assert.equal((await checkPdf(pdf)).title, 'Math for Programmers');
    await assert.rejects(checkPdf(join(dir, 'nope.pdf')), /Not found/);

    const seen = [];
    let release;
    const gate = new Promise(r => { release = r; });
    const convert = async (src, out, { onProgress }) => {
      onProgress({ done: 0, total: 20 });
      await gate;                                   // hold step 1 open so its state can be read
      onProgress({ done: 20, total: 20 });
      await writeFile(out, '# Vectors\n\nA vector is an arrow in the plane.\n\n# Calculus\n\nDerivatives measure change.\n');
      return { pages: 20, chars: 90, headings: 2, codeBlocks: 0 };
    };
    const summarizeFn = async (a) => { seen.push(a.section); return fakeSummary(a); };

    const first = await addPdf(pdf, undefined, { convert, summarizeFn, root });
    const conv = first.conversion;
    assert.equal(conv.running, true);
    assert.equal(conv.file, 'Math_for_Programmers.pdf');
    assert.deepEqual([conv.done, conv.total], [0, 0]);
    assert.equal((await addPdf(pdf, undefined, { convert, summarizeFn, root })).conversion, conv, 'a second add joins the running conversion');
    assert.deepEqual(await listBooks(root), [], 'no book until step 1 is done');

    release();
    await conv.promise;
    assert.equal(conv.error, null);
    assert.equal(conv.running, false);
    const [book] = await listBooks(root);
    assert.equal(book.name, 'Math for Programmers');
    assert.equal(book.pdf, pdf);
    assert.equal(book.sourceDir, join(root, book.id, 'source'));
    assert.equal(book.sourceFile, 'math-for-programmers.md');
    assert.deepEqual((await readdir(root)).filter(n => n.startsWith('.convert-')), [], 'temp folder removed');
    assert.deepEqual((await readdir(dir)).filter(n => n.endsWith('.md')), [], 'nothing written next to the PDF');

    // step 2 ran over the converted markdown
    for (let i = 0; i < 50 && seen.length < 1; i++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(seen, ['math-for-programmers.md']);
    assert.match((await searchBook(book, 'derivatives', root)).matches[0].snippets[0], /Derivatives measure change/);

    const again = await addPdf(pdf, 'Another title', { convert, summarizeFn, root });
    assert.equal(again.existed, true);
    assert.equal(again.book.id, book.id);
    assert.equal((await findPdfBook(pdf, root)).id, book.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('PDF book: a failed conversion leaves no book and keeps the reason', async () => {
  const { dir, root } = await fixture();
  try {
    const pdf = join(dir, 'scan.pdf');
    await writeFile(pdf, '%PDF-1.7');
    const { conversion } = await addPdf(pdf, undefined, { root, convert: async () => { throw new Error('this PDF has almost no text layer — it looks scanned and needs OCR first'); } });
    await conversion.promise;
    assert.equal(conversion.running, false);
    assert.match(conversion.error, /looks scanned/);
    assert.deepEqual(await listBooks(root), []);
    assert.deepEqual(await readdir(root).catch(() => []), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
