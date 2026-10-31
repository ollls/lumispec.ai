import { test } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToMarkdown } from '../src/tools/plugin-web.js';

// Shape of the NYT homepage on 2026-10-31 (logs/browser-debug/fetch-thin-*.html): one embedded
// interactive ships ~100K chars of inert markup inside <template>. Readability scored that
// section as the article, Turndown rendered the template as nothing, and web_fetch reported
// "browser returned 0 chars" for a page with 130K chars of visible text.
const inert = '<p>' + 'inert template text. '.repeat(5000) + '</p>';
const page = `<!DOCTYPE html><html><head><title>Front Page</title></head><body>
<header><nav><a href="/">Home</a></nav></header>
<main>
  <section><h3>First real headline</h3><p>A short summary of the first story on the page.</p></section>
  <section><h3>Second real headline</h3><p>A short summary of the second story on the page.</p></section>
  <section id="interactive"><figure><div><template data-etched-id="1">${inert}</template></div></figure></section>
</main>
<footer>Footer</footer></body></html>`;

test('template contents never become the extracted article', () => {
  const { markdown, title } = htmlToMarkdown(page);
  assert.ok(markdown.includes('First real headline'), markdown.slice(0, 200));
  assert.ok(markdown.includes('Second real headline'));
  assert.ok(!markdown.includes('inert template text'));
  assert.equal(title, 'Front Page');
});

test('an article Turndown renders as empty falls back to the whole body', () => {
  // Readability returns content, but it is only an image with no src: Turndown emits nothing.
  const html = `<!DOCTYPE html><html><head><title>Gallery</title></head><body>
<article><div>${'<img alt="x"> '.repeat(40)}</div></article>
<section><h2>Visible heading</h2><p>Visible paragraph text that should survive.</p></section>
</body></html>`;
  const { markdown } = htmlToMarkdown(html);
  assert.ok(markdown.includes('Visible heading'), markdown.slice(0, 200));
});

// Index pages: every headline is a paragraph inside a link, which Readability prunes as a
// link-dense block, leaving summaries with no headlines (NYT homepage and Guardian date
// archive, 2026-10-31). Such pages render as one line per linked story instead.
function indexPage(n) {
  const stories = Array.from({ length: n }, (_, i) => `
    <div><div><a href="/2026/10/30/story-${i}"><div><p>Headline number ${i} that is long enough to count</p></div></a></div>
    <div><p>Summary for story ${i}, a sentence or two of plain text beside the headline.</p></div></div>`).join('');
  return `<!DOCTYPE html><html><head><title>Front Page</title></head><body>
<header><nav><a href="/">Home</a><a href="/world">World</a></nav></header>
<main>${stories}</main><footer>Footer</footer></body></html>`;
}

test('an index page renders as a headline list with absolute URLs and summaries', () => {
  const { markdown, title } = htmlToMarkdown(indexPage(20), 'https://news.example.com/');
  assert.equal(title, 'Front Page');
  assert.ok(markdown.includes('Index page: 20 linked stories'), markdown.slice(0, 200));
  assert.ok(markdown.includes('- [Headline number 0 that is long enough to count](https://news.example.com/2026/10/30/story-0) — Summary for story 0'));
  assert.ok(markdown.includes('Headline number 19 that is long enough to count'));
  assert.ok(!markdown.includes('[Home]'), 'nav links are not stories');
});

test('an article page with a few links still goes through Readability', () => {
  const body = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i} of the article body, with enough ordinary prose to be scored as content by Readability and kept.</p>`).join('');
  const html = `<!DOCTYPE html><html><head><title>Article</title></head><body>
<nav><a href="/">Home</a></nav><article><h1>Article headline</h1>${body}
<p>See also <a href="/other-story">another long story title linked from the text</a>.</p></article></body></html>`;
  const { markdown } = htmlToMarkdown(html, 'https://news.example.com/');
  assert.ok(!markdown.includes('Index page:'), markdown.slice(0, 200));
  assert.ok(markdown.includes('Paragraph 11 of the article body'));
});

test('the per-fetch cap is an option, defaulting to FETCH_MAX_CHARS', async () => {
  const { FETCH_MAX_CHARS } = await import('../src/tools/plugin-web.js');
  const long = '<html><body><article>' + '<p>Paragraph of article text that is kept by Readability. </p>'.repeat(400) + '</article></body></html>';
  const def = htmlToMarkdown(long, 'https://x.example/');
  assert.ok(def.markdown.length <= FETCH_MAX_CHARS + 20, String(def.markdown.length));
  assert.ok(def.markdown.endsWith('[...truncated]'));
  const small = htmlToMarkdown(long, 'https://x.example/', { maxChars: 1500 });
  assert.equal(FETCH_MAX_CHARS, 4000);
  assert.ok(small.markdown.length <= 1520, String(small.markdown.length));
  assert.ok(small.markdown.endsWith('[...truncated]'));
});
