#!/usr/bin/env python3
"""Convert a PDF with a text layer to Markdown for Books (src/tools/plugin-books.js).

Usage: pdf_to_md.py <in.pdf> <out.md>

Generic on purpose — no per-book margins or font sizes:
  - headings come from the PDF's own outline (bookmarks): each entry becomes a heading on its
    page, at the line that carries its title, or at the top of the page when no line matches.
    Without an outline, short lines set clearly larger than the body text become headings.
  - running headers / footers (text repeated at the top or bottom of several pages) and page
    numbers are dropped
  - monospaced blocks become fenced code, so a `# comment` never reads as a heading
  - words hyphenated across a line break are rejoined
Bold / italic markup, images and table structure are not reproduced.

Progress protocol on stdout, one line each:  PAGES <n> · PROGRESS <done> <n> · DONE <chars>
<headings> <code blocks> · ERROR <message> (exit code 2: unusable input, 3: no text layer).
"""
import re
import sys
from collections import Counter


def fail(msg, code=2):
    print(f'ERROR {msg}', flush=True)
    sys.exit(code)


try:
    import pymupdf
except ImportError:
    try:
        import fitz as pymupdf
    except ImportError:
        fail('MISSING_PYMUPDF')

if len(sys.argv) != 3:
    fail('usage: pdf_to_md.py <in.pdf> <out.md>')
SRC, OUT = sys.argv[1], sys.argv[2]

try:
    doc = pymupdf.open(SRC)
except Exception as e:  # noqa: BLE001
    fail(f'cannot open the PDF: {e}')
if doc.needs_pass:
    fail('the PDF is password-protected')
N = len(doc)
if N == 0:
    fail('the PDF has no pages')
print(f'PAGES {N}', flush=True)

ZONE = 0.08          # top / bottom share of the page where running heads live
MIN_REPEAT = 4       # a zone line seen on this many pages is a running head
MONO_RE = re.compile(r'mono|courier|consol|menlo|inconsolata|source ?code|fira ?code|typewriter|lucida ?console', re.I)

WORDS = set()
try:
    with open('/usr/share/dict/words', encoding='utf-8', errors='ignore') as f:
        WORDS = {w.strip().lower() for w in f if w.strip()}
except OSError:
    pass


def norm(s):
    return re.sub(r'[^a-z0-9]+', '', s.lower())


def zone_key(s):
    return re.sub(r'\d+', '#', re.sub(r'\s+', ' ', s).strip().lower())


def is_mono(span):
    return bool(span['flags'] & 8) or bool(MONO_RE.search(span['font']))


def line_text(line):
    return ''.join(s['text'] for s in line['spans'])


# ── Pass 1: extract every page once (the slow part), collect statistics ──

FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
pages = []                 # per page: (height, [block])
sizes = Counter()          # font size → chars, to find the body size
zone_seen = Counter()      # normalized zone line → pages it appears on
total_chars = 0

for i in range(N):
    page = doc[i]
    h = page.rect.height
    blocks = []
    keys = set()
    for b in page.get_text('dict', flags=FLAGS)['blocks']:
        lines = [l for l in b.get('lines', []) if line_text(l).strip()]
        if not lines:
            continue
        blocks.append(lines)
        for l in lines:
            y0, y1 = l['bbox'][1], l['bbox'][3]
            t = line_text(l)
            total_chars += len(t)
            for s in l['spans']:
                sizes[round(s['size'], 1)] += len(s['text'])
            if y1 <= h * ZONE or y0 >= h * (1 - ZONE):
                keys.add(zone_key(t))
    for k in keys:
        zone_seen[k] += 1
    pages.append((h, blocks))
    if (i + 1) % 10 == 0 or i + 1 == N:
        print(f'PROGRESS {i + 1} {N}', flush=True)

if total_chars / N < 80:
    fail('this PDF has almost no text layer — it looks scanned and needs OCR first', 3)

body_size = sizes.most_common(1)[0][0]

# Outline entries per page (0-based), in order
toc_by_page = {}
for lvl, title, pno in doc.get_toc():
    title = re.sub(r'\s+', ' ', title).strip()
    if title and 1 <= pno <= N:
        toc_by_page.setdefault(pno - 1, []).append([min(lvl, 3), title, norm(title), False])
HAS_TOC = bool(toc_by_page)


# ── Pass 2: build markdown ──

def in_zone(line, h):
    return line['bbox'][3] <= h * ZONE or line['bbox'][1] >= h * (1 - ZONE)


def running_head(line, h):
    if not in_zone(line, h):
        return False
    t = line_text(line).strip()
    return bool(re.fullmatch(r'[\divxlcIVXLC.\-– ]{1,8}', t)) or zone_seen[zone_key(t)] >= MIN_REPEAT


def join_lines(texts):
    out = ''
    for t in texts:
        t = re.sub(r'\s+', ' ', t).strip()
        if not t:
            continue
        m = re.search(r'([A-Za-z]+)-$', out)
        nxt = re.match(r'[a-z]+', t)
        if m and nxt:
            stem, tail = m.group(1), nxt.group(0)
            joined = (stem + tail).lower()
            # keep the hyphen only when the dictionary knows the hyphenated form and not the joined one
            if WORDS and joined not in WORDS and (stem.lower() in WORDS and tail in WORDS) and len(tail) > 3 and len(stem) > 3:
                out = out + t
            else:
                out = out[:-1] + t
        else:
            out = f'{out} {t}' if out else t
    return out


def match_toc(pno, text):
    """Outline entry on this page whose title this short block carries, else None."""
    n = norm(text)
    if len(n) < 2 or len(text) > 200:
        return None
    for e in toc_by_page.get(pno, []):
        if e[3]:
            continue
        t = e[2]
        if n == t or (n.endswith(t) and len(n) - len(t) <= 8) or (len(n) >= 6 and t.endswith(n) and len(t) - len(n) <= 8):
            e[3] = True
            return e
    return None


def size_heading(lines):
    """No outline: a short block set clearly larger than the body is a heading."""
    if len(lines) > 2:
        return None
    spans = [s for l in lines for s in l['spans'] if s['text'].strip()]
    text = join_lines([line_text(l) for l in lines])
    if not spans or len(text) > 120 or len(norm(text)) < 3:
        return None
    size = max(spans, key=lambda s: len(s['text']))['size']
    if size >= body_size * 1.6:
        return 1
    if size >= body_size * 1.3:
        return 2
    if size >= body_size * 1.15:
        return 3
    return None


out = []
n_head = n_code = 0
for pno, (h, blocks) in enumerate(pages):
    items = []          # ('h', lvl, text) | ('p', text) | ('code', [lines])
    for lines in blocks:
        lines = [l for l in lines if not running_head(l, h)]
        if not lines:
            continue
        spans = [s for l in lines for s in l['spans'] if s['text'].strip()]
        chars = sum(len(s['text']) for s in spans)
        mono = sum(len(s['text']) for s in spans if is_mono(s))
        if chars and mono / chars > 0.8 and not match_toc(pno, join_lines([line_text(l) for l in lines])):
            code = [line_text(l).rstrip() for l in lines]
            if items and items[-1][0] == 'code':
                items[-1][1].extend(code)
            else:
                items.append(('code', code))
            continue
        text = join_lines([line_text(l) for l in lines])
        if len(text) < 2:
            continue
        e = match_toc(pno, text) if HAS_TOC else None
        if e:
            items.append(('h', e[0], e[1]))
        elif not HAS_TOC and size_heading(lines):
            items.append(('h', size_heading(lines), text))
        else:
            items.append(('p', text))
    # outline entries with no matching line still open their section, at the top of the page
    missing = [('h', e[0], e[1]) for e in toc_by_page.get(pno, []) if not e[3]]
    # a title often sits in two blocks ("1.3.1" + "Using a formal language"): drop the stray
    # numbering paragraph right before a matched heading
    cleaned = []
    for it in missing + items:
        if it[0] == 'h' and cleaned and cleaned[-1][0] == 'p' and re.fullmatch(r'(chapter|part|appendix)?\s*[\dA-Z.]{1,8}', cleaned[-1][1], re.I):
            cleaned.pop()
        cleaned.append(it)
    for it in cleaned:
        if it[0] == 'h':
            out.append('#' * it[1] + ' ' + it[2])
            n_head += 1
        elif it[0] == 'code':
            out.append('```\n' + '\n'.join(it[1]) + '\n```')
            n_code += 1
        else:
            out.append(it[1])

result = '\n\n'.join(out) + '\n'
with open(OUT, 'w', encoding='utf-8') as f:
    f.write(result)
print(f'DONE {len(result)} {n_head} {n_code}', flush=True)
