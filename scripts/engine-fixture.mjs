// Turns a search results page into the fixture committed under test/fixtures/engines/.
//
// The repository is public and the page comes out of the maintainer's own browser, so a fixture
// keeps only what a parser reads: the result list's elements, their class / id, the result links
// and the visible text (public search results). Everything else is dropped or emptied — the page
// header (account, location), scripts, forms, images, and every opaque value the engine attaches
// to a search (Google's ved / sca_esv / ei, Bing's impression and click ids, Brave's link tokens),
// which cannot be shown to be free of session data.
import { parseHTML } from 'linkedom';

// Where each engine keeps its result list.
export const RESULT_ROOTS = {
  duckduckgo: ['#links', '.results', '.serp__results'],
  brave: ['#mixed-main', '#results', 'main main', 'main'],
  bing: ['#b_results'],
  google: ['#rso', '#search'],
};

// Attributes kept with their value. Any other data-* attribute and jscontroller stay as EMPTY
// attributes (parsers select on their presence); the rest are removed.
const KEEP = new Set(['class', 'id', 'href', 'data-resolved-href', 'data-type']);
// On a link back to the engine itself, the only query parameters a parser decodes.
const OWN_LINK_PARAMS = new Set(['u', 'q', 'url', 'uddg']);

function cleanHref(href, pageUrl, site) {
  let u;
  try { u = new URL(href, pageUrl); } catch { return '#'; }
  if (!/^https?:$/.test(u.protocol)) return '#';
  const own = u.hostname === site || u.hostname.endsWith('.' + site);
  if (!own) return u.href; // a result's address: the thing under test
  for (const key of [...u.searchParams.keys()]) if (!OWN_LINK_PARAMS.has(key)) u.searchParams.delete(key);
  if (u.hash) u.hash = 'x';
  // Keep the page-relative form the engine wrote, so base-URL handling is still exercised.
  return /^https?:|^\/\//i.test(href) ? u.href : u.pathname + u.search + u.hash;
}

/**
 * @param {string} id engine id
 * @param {{ url: string, html: string }} page
 * @param {string} site the engine's own domain ("bing.com")
 * @returns {string|null} fixture HTML, or null when the result list was not found
 */
export function reduceToResults(id, page, site) {
  const { document } = parseHTML(page.html);
  const root = (RESULT_ROOTS[id] || []).map(sel => document.querySelector(sel)).find(Boolean);
  if (!root) return null;
  for (const el of root.querySelectorAll('script, style, noscript, template, svg, form, input, iframe, img, picture, video, source')) el.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const { name, value } of [...el.attributes]) {
      if (name === 'href') el.setAttribute(name, cleanHref(value, page.url, site));
      else if (name === 'data-resolved-href') { if (!/^https?:\/\//i.test(value)) el.removeAttribute(name); }
      // Generated element ids carry a per-request GUID (Bing's video carousel).
      else if (name === 'id') el.setAttribute(name, value.replace(/[0-9a-f]{16,}/gi, 'x'));
      else if (KEEP.has(name)) continue;
      // Google's snippet is found by its line-clamp style; no other style matters.
      else if (name === 'style' && /line-clamp/.test(value)) el.setAttribute(name, '-webkit-line-clamp:2');
      else if (name.startsWith('data-') || name === 'jscontroller') el.setAttribute(name, '');
      else el.removeAttribute(name);
    }
  }
  return `<html><body>${root.outerHTML.replace(/<!--[\s\S]*?-->/g, '')}</body></html>\n`;
}
