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
