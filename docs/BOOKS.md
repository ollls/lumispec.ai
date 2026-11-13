# Books — index a folder, open it, chat against it

A **book** is a folder of `.md` / `.txt` files anywhere on your disk — a manual, a novel split into
chapters, a set of notes, another project's docs — a single such file, or a **PDF**. Lumispec indexes it into its own directory, you
make it the **open book**, and the assistant answers from it first.

## Quick start

1. **Plugins → Books** → switch it on.
2. Type the folder path — or the path of one `.md` / `.txt` file — into **Add a book** and press
   Enter. A file path makes that one file the book; nothing else in its directory is included. The book is added, opened, and
   indexing starts in the background. The card shows progress (`Indexing "SICP": 37/212 sections…`).
3. Chat. You can ask questions right away — search covers the full text even before the summaries
   are written.

The same from chat: *"add ~/books/sicp as a book called SICP"*, *"open SICP"*, *"what books do I
have?"*, *"index it"*, *"close the book"*, *"remove the book SICP"*.

## Adding a PDF

Give **Add a book** the path of a `.pdf` (or ask in chat: *"add ~/Documents/book.pdf to my
books"*). It takes two steps, and the card's status line tells you which one is running:

1. `Step 1 of 2 — converting book.pdf to markdown: page 120/690…` — the text is extracted with
   headings taken from the PDF's own outline (bookmarks), running headers and page numbers
   dropped, code set in fenced blocks. Seconds, not minutes.
2. `Step 2 of 2 — indexing "book": 37/121 sections…` — the usual background indexing. The book
   opens as soon as step 1 is done, so you can already ask questions.

A toast marks each change of step and the end. The markdown is kept in the app
(`data/books/<id>/source/`); nothing is written next to your PDF. Adding the same PDF again just
opens its book.

If step 1 fails the status line says why: a **scanned PDF** has no text layer and needs OCR first;
a missing PyMuPDF shows the install command for your Python environment.

## What "open" means

One book is open at a time, for every conversation. While it is open the assistant:

- searches the book before any other tool, reads the best sections, and names the section an
  answer rests on, e.g. `(ch03.md#2)`;
- says so first when the book does not cover the question, and only then uses web search or its
  own knowledge, marked as not from the book.

**Book only** (checkbox on the card) goes further: while a book is open, web search, Python and
every other plugin's tools are withheld, and the assistant answers "not in this book" instead of
looking elsewhere. Untick it, or close the book, to get the tools back.

## Where things live

| What | Where |
|---|---|
| The book | Your folder or file. Never modified. |
| A PDF's markdown | `data/books/<id>/source/` |
| Its index | `data/books/<id>/index/` — one short summary per section |
| Its record | `data/books/<id>/book.json` — name and folder path |
| Which book is open | `data/plugins.json` → `books.activeBook` |

Removing a book deletes `data/books/<id>/` only.

## Sections

Files up to 16,000 characters are one section. Longer files are cut at paragraph breaks (and at
headings where possible), so a whole book in a single `.txt` works: sections are named
`book.txt#1`, `book.txt#2`, … Each section costs one LLM call to index and about 4K tokens to
read.

Edit a file and its sections are marked "to index"; the **Index N sections** button (or *"index
the book"*) rebuilds only those. Indexing stops by itself if the LLM is unreachable and resumes
where it left off.

## Limits

- Markdown, plain text and PDFs with a text layer. Images, table layout and bold / italic are not
  carried over from a PDF. EPUB: `pandoc book.epub -o book.md`, then add the `.md`.
- Search is keyword-based (no embeddings): ask with the book's own words, or let the assistant
  try a few.
- The open book is one global setting, not per conversation.
- The project wiki (`wiki/`, `wiki_scan` / `wiki_index`) is a separate plugin and is unchanged.
