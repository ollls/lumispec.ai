// LLM review of a saved applet template: the audit that finds what is wrong, the prompt that asks
// the model to fix it, and the guard that decides whether the model's answer may replace the
// original. Pure — the LLM call is injected — so the whole flow is testable without a server.
//
// Why this exists (2026-11-06): an AMD intraday applet was saved as a template straight from the
// chat. The saved HTML still had `const DATA = __DATA__;` (the data was never injected), the date
// baked into the <h2>, no error path and no resize postMessage. It took a manual chat session with
// the source tools to rewrite it to discover its files via /api/files?match=amd and fetch them at
// render time. `reviewTemplateHtml()` is that fix, run automatically on "Save as Template".

import { Script } from 'vm';
import { splitTemplateNotes } from './templateExpansion.js';

// ── Deterministic sanitizer (ran on POST/PATCH since before the review existed) ──────────────

export function sanitizeTemplate(html) {
  // Python → JS: None → null, True → true, False → false (in JS context only)
  // Match inside <script> blocks to avoid touching HTML content
  html = html.replace(/(<script[\s>][\s\S]*?<\/script>)/gi, (scriptBlock) => {
    return scriptBlock
      .replace(/===\s*None\b/g, '=== null')
      .replace(/!==\s*None\b/g, '!== null')
      .replace(/\bNone\b(?=\s*[;,)\]}|&?:])/g, 'null')
      .replace(/===\s*True\b/g, '=== true')
      .replace(/===\s*False\b/g, '=== false')
      .replace(/\bTrue\b(?=\s*[;,)\]}|&?:])/g, 'true')
      .replace(/\bFalse\b(?=\s*[;,)\]}|&?:])/g, 'false');
  });
  // CDN → local Chart.js
  html = html.replace(/https?:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js[^"']*/g, '/lib/chart.min.js');
  html = html.replace(/https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"']*/g, '/lib/chart.min.js');
  // Remove stray semicolons inside closing tags: </div>;" → </div>"
  html = html.replace(/<\/div>;"/g, '</div>"');
  html = html.replace(/<\/div>;'/g, "</div>'");
  return html;
}

// ── Audit ───────────────────────────────────────────────────────────────────────────────────

/** `__DATA__`, `{{rows}}`, `/* data here *\/`, `<!-- INSERT ... -->` — a slot the data never filled. */
const PLACEHOLDER_RE = /\b__[A-Z][A-Z0-9_]*__\b|\{\{\s*[\w.]+\s*\}\}|\/\*\s*(?:data|insert|todo|fill)[^*]*\*\/|<!--\s*(?:data|insert|todo|fill)[^>]*-->/i;

/** "Friday Nov 6, 2026", "Nov 6, 2026", "2026-11-06", "11/06/2026" inside element text (not inside <script>). */
const DATE_TEXT_RE = /(?:\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+)?\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/;

const MONEY_RE = /\$\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?|\$\s?\d+\.\d{2}\b/;

function scriptBlocks(html) {
  return [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
}

function withoutScripts(html) {
  return String(html).replace(/<script[\s>][\s\S]*?<\/script>/gi, '');
}

/** Rough count of literal numbers inside array literals in the script — a hardcoded dataset leaves dozens. */
function literalDataPoints(js) {
  // Outermost array literals, found by bracket depth so nested rows ([[t, p, v], …]) count as one dataset.
  let n = 0;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < js.length; i++) {
    const c = js[i];
    if (c === '[') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ']' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        // Strings and call arguments (rgba(74,158,255,0.15), toFixed(2)) are configuration, not data.
        const body = js.slice(start + 1, i)
          .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""')
          .replace(/\b[\w.$]+\([^()]*\)/g, 'f()');
        const nums = body.match(/-?\d+(?:\.\d+)?/g);
        if (body.length >= 20 && nums && nums.length >= 6) n += nums.length;
        start = -1;
      }
    }
  }
  return n;
}

/**
 * Deterministic findings about a template, as short strings the model (and the UI) can read.
 * Empty means nothing we know how to detect — the LLM still looks, but with a lighter touch.
 */
/** `notes` are the template's author notes (context the HTML must agree with), see `contractIssues`. */
export function auditTemplate(html, notes = '') {
  const issues = [];
  const src = String(html);
  const js = scriptBlocks(src).join('\n');
  const markup = withoutScripts(src);
  const fetches = js.includes('fetch(');
  const usesFiles = /\/files\/|\/api\/files/.test(js);

  const ph = src.match(PLACEHOLDER_RE);
  if (ph) issues.push(`unresolved placeholder "${ph[0].trim().slice(0, 40)}" — the data this applet rendered was never written into the saved HTML`);

  const points = literalDataPoints(js);
  if (points >= 12 && !usesFiles) issues.push(`~${points} numbers hardcoded in array literals and no fetch from /files/ — the template will always show this one snapshot`);

  if (fetches && !/\.catch\(|catch\s*(?:\(|\{)/.test(js)) issues.push('fetch() without any catch — a missing file fails silently with an empty applet');
  // A clock, a timer or an animation changes every run without any data; the Beautiful Watch
  // (2026-11-07) was told it was static and the model invented a fetch of "/api/files?match=watch"
  // that parsed the first match as JSON — an error overlay the moment a watch.html existed.
  const clockDriven = /new Date\(|Date\.now\(|setInterval\(|requestAnimationFrame\(/.test(js);
  if (!fetches && !ph && points < 12 && !usesFiles && !clockDriven) issues.push('static: no data loading and nothing time-driven — the template shows the same thing every run; only add data loading if the markup clearly presents data that should refresh');

  if (!/postMessage\s*\(/.test(js)) issues.push("no resize postMessage — the host iframe cannot size itself to the content");

  const date = markup.match(DATE_TEXT_RE);
  if (date) issues.push(`date "${date[0]}" written into the markup — should come from the data or new Date() at render time`);

  const money = markup.match(MONEY_RE);
  if (money) issues.push(`value "${money[0]}" written into the markup — a result, not a template`);

  if (/\bNone\b|\bTrue\b|\bFalse\b/.test(js)) issues.push('Python literals (None/True/False) inside JavaScript');
  if (/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com/.test(src)) issues.push('loads a library from a CDN — Chart.js is served locally at /lib/chart.min.js');

  if (/<select[^>]*>\s*<\/select>/i.test(markup) && !/\.options\.add|appendChild\(.*option|innerHTML\s*=.*<option/i.test(js)) {
    issues.push('empty <select> that nothing populates');
  }

  issues.push(...contractIssues(src, notes));
  return issues;
}

// ── Notes vs. markup ────────────────────────────────────────────────────────────────────────
// The author's notes (tpl.notes, see services/templates.js) tell the assistant which files to
// build and with which columns; the HTML has to look for exactly those. Since 2026-11-07 the two
// live apart, so the audit checks that every file and every column the notes name is something the
// markup references — the only place a drift between contract and template is caught.

const NOTED_FILE_RE = /\b[\w][\w.-]*\.(?:csv|json)\b/g;
/** "header exactly: date,chpy,smh,sox", "columns: date, open, close" — the first comma list after such a word. */
const NOTED_HEADER_RE = /\b(?:header|columns?|fields)\b[^:\n]{0,20}:\s*([a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)+)/i;

export function contractIssues(html, notes = '') {
  const text = String(notes || '');
  if (!text.trim()) return [];
  const src = String(html || '');
  const lower = src.toLowerCase();
  // Quoted strings, plus the keyword of any inline `?match=amd` (a literal that holds the whole URL)
  const literals = [...src.matchAll(/'([^'\n]{3,})'|"([^"\n]{3,})"/g)].map(m => (m[1] ?? m[2]).toLowerCase())
    .concat([...src.matchAll(/match=([\w.-]+)/gi)].map(m => m[1].toLowerCase()));
  const issues = [];

  const files = [...new Set(text.match(NOTED_FILE_RE) || [])].map(f => ({ file: f, name: f.toLowerCase(), stem: f.toLowerCase().replace(/\.(csv|json)$/, '') }));
  for (const { file, name, stem } of files) {
    // Referenced by name, by a literal holding the whole stem, or by a match keyword that is a prefix of
    // this stem and of no other noted file's (`chpy_smh_sox` selects chpy_smh_sox.csv AND
    // chpy_smh_sox_meta.json, so the meta file needs a keyword of its own — `?match=amd` for one file is fine).
    const referenced = lower.includes(name) || literals.some(l =>
      l.includes(stem) || (l.length >= 3 && stem.startsWith(l) && !files.some(o => o.stem !== stem && o.stem.startsWith(l))));
    if (!referenced) issues.push(`notes name the data file "${file}" but the HTML never references it (no filename or match keyword)`);
  }

  const header = text.match(NOTED_HEADER_RE);
  if (header) {
    const missing = header[1].split(',').map(c => c.trim().toLowerCase()).filter(c => c && c !== 'date' && !new RegExp(`\\b${c}\\b`, 'i').test(src));
    if (missing.length) issues.push(`notes promise the column(s) ${missing.join(', ')} but the HTML never mentions them`);
  }
  return issues;
}

// ── Prompt ──────────────────────────────────────────────────────────────────────────────────

export const REVIEW_SYSTEM_PROMPT = `You are an HTML/JS template reviewer. You receive an applet HTML template that was saved from a chat answer, and return an IMPROVED version that works as a reusable template: every time it is rendered it must load the CURRENT data itself.

Rules:
- Return ONLY the complete HTML — no explanation, no markdown, no code fences
- Unresolved placeholders such as __DATA__, {{rows}} or "insert data here" are the most common defect: the applet's data was never written into the saved HTML. Replace them with runtime loading (below). Never leave a placeholder in the output.
- Data loading: if the template has hardcoded data arrays or placeholders, load the data at render time instead: discover files with fetch('/api/files?match=KEYWORD') (returns a JSON array of filenames in the project directory, matched case-insensitively; pick a short lowercase KEYWORD from the template's subject — a ticker, a dataset name), then fetch('/files/' + filename) and parse client-side (.json → response.json(), .csv → split lines and commas). NEVER hardcode filenames that contain timestamps, IDs, or other generated values.
- When multiple files exist for the same data type (e.g. different dates/expiries), deduplicate by logical key and keep the most recent file per key
- Dates, times and values written into headings or labels ("Friday Nov 6, 2026", "$241.37") must be computed from the loaded data or new Date() when the template renders
- Add error handling for every fetch() with a user-visible message (e.g. a <div id="err">), including the case where no matching file exists
- For select/dropdown elements: populate options dynamically from loaded data, never leave empty <select> elements
- Ensure the resize postMessage is present: window.parent.postMessage({type:'resize',height:document.body.scrollHeight},'*') after the data renders
- Fix JavaScript bugs: None→null, True→true, False→false, undeclared variables
- Replace CDN URLs with local: Chart.js → /lib/chart.min.js
- Remove hardcoded stock symbols, dollar amounts, account names, or personal data from the markup — replace with data-driven rendering
- Do NOT add a data source the template never had: a clock, a timer, a static layout or a self-contained visualization needs no fetch(). Only load data where the original rendered data (arrays, placeholders, values in the markup)
- Do NOT add brand names, service names, or attribution text that was not in the original template
- Preserve working logic: if existing code (event handlers, select population, data parsing) works correctly, keep it — only refactor what is broken or hardcoded
- Keep the exact same visual design, CSS, layout, and color scheme
- Keep it concise — do not add comments or expand minified code
- When outputting minified JS, ensure all statement terminators (semicolons) are preserved`;

/**
 * The user turn: the author's notes (context only — they are stored apart from the HTML and must
 * not come back in it), then the audit so the model fixes what we already know is wrong, then the
 * template. With neither, it is the bare HTML.
 */
export function reviewUserMessage(html, issues = [], notes = '') {
  const parts = [];
  if (notes && String(notes).trim()) {
    parts.push(`Template notes — the author's instructions to the assistant that renders this template (which files it builds, which columns and series they carry). CONTEXT ONLY: they are stored separately, are NOT part of the HTML and must NOT appear in your output. Keep the HTML consistent with them — file names, match keywords, column names, series.\n${String(notes).trim()}`);
  }
  if (issues.length) {
    parts.push(`Automatic audit of this template found:\n${issues.map(i => `- ${i}`).join('\n')}\n\nFix these (and anything else the rules cover) and return the complete HTML.`);
  }
  parts.push(html);
  return parts.join('\n\n');
}

// ── Guard ───────────────────────────────────────────────────────────────────────────────────

/**
 * The first inline <script> that does not parse, as "line N: message", or null. Parse only — the
 * code never runs. 2026-11-07: the review model rewrote `/(_n|_norm)$/;` as `/(_n|_norm)$/);`
 * in the CHPY template (the chat model had made the same slip copying it that morning); nothing
 * checked the JavaScript, the record was replaced, and every later run copied the SyntaxError.
 */
export function scriptSyntaxError(html) {
  for (const js of scriptBlocks(html)) {
    try {
      new Script(js, { filename: 'template.js' });
    } catch (err) {
      const line = (err.stack || '').match(/template\.js:(\d+)/);
      return `${line ? `line ${line[1]}: ` : ''}${err.message}`;
    }
  }
  return null;
}

/** Markdown fences the model may wrap the answer in, plus a leading "Here is…" line. */
export function stripFences(content) {
  let s = String(content || '').trim();
  const fence = s.match(/^[^\n`]{0,80}\n?```(?:html)?\s*\n([\s\S]*?)\n?```\s*$/i);
  if (fence) return fence[1].trim();
  s = s.replace(/^```(?:html)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  return s.trim();
}

/**
 * Whether `reviewed` may replace `original`. The model's answer is rejected when it is not an
 * HTML document any more, lost the chart or the script, still carries a placeholder, or changed
 * size so much that it cannot be the same template.
 */
export function validateReviewed(original, reviewed, type = 'html') {
  const out = String(reviewed || '').trim();
  const src = String(original || '');
  if (!out) return { ok: false, reason: 'empty response' };
  if (/^```|```$/m.test(out)) return { ok: false, reason: 'markdown fence left in output' };
  if (!/<\/?(?:html|body|script|div|svg|canvas)[\s>]/i.test(out)) return { ok: false, reason: 'not HTML' };
  if (/^(?:here|sure|i |the |this )/i.test(out)) return { ok: false, reason: 'starts with prose, not markup' };
  if (PLACEHOLDER_RE.test(out)) return { ok: false, reason: `placeholder still present: "${out.match(PLACEHOLDER_RE)[0].trim().slice(0, 40)}"` };
  if (/<script[\s>]/i.test(src) && !/<script[\s>]/i.test(out)) return { ok: false, reason: 'script block lost' };
  if (/<\/html>/i.test(src) && !/<\/html>/i.test(out)) return { ok: false, reason: 'document cut short (no </html>)' };
  if ((type === 'chartjs' || /new Chart\(/.test(src)) && !/new Chart\(/.test(out)) return { ok: false, reason: 'Chart.js instantiation lost' };
  if (type === 'svg' && /<svg[\s>]/i.test(src) && !/<svg[\s>]/i.test(out)) return { ok: false, reason: 'SVG lost' };
  const ratio = out.length / Math.max(1, src.length);
  if (ratio < 0.4) return { ok: false, reason: `output is ${Math.round(ratio * 100)}% of the original size` };
  if (ratio > 4) return { ok: false, reason: `output is ${ratio.toFixed(1)}× the original size` };
  const openScripts = (out.match(/<script[\s>]/gi) || []).length;
  const closeScripts = (out.match(/<\/script>/gi) || []).length;
  if (openScripts !== closeScripts) return { ok: false, reason: 'unbalanced <script> tags' };
  // Working code may only be replaced by code that parses (an original that never parsed is not held to this)
  const syntax = scriptSyntaxError(out);
  if (syntax && !scriptSyntaxError(src)) return { ok: false, reason: `script does not parse (${syntax})` };
  return { ok: true };
}

// ── Orchestration ───────────────────────────────────────────────────────────────────────────

/**
 * Review one template's HTML. `complete(messages, opts)` is the LLM call (collectChatCompletion)
 * and returns `{ content }`. Resolves to:
 *   { html, changed, issues, applied: true }                 — the reviewed HTML replaced the original
 *   { html: original, changed: false, issues, applied: false, reason } — kept the original, and why
 * Never throws for a bad model answer; a transport error surfaces as `reason` too.
 */
export async function reviewTemplateHtml(html, type, { complete, maxTokens = 8192, log = () => {}, notes = '' } = {}) {
  const original = String(html || '');
  const issues = auditTemplate(original, notes);
  log(`[template-review] audit: ${issues.length ? issues.join(' | ') : 'nothing flagged'}`);
  let content;
  try {
    ({ content } = await complete([
      { role: 'system', content: REVIEW_SYSTEM_PROMPT },
      { role: 'user', content: reviewUserMessage(original, issues, notes) },
    ], { maxTokens }));
  } catch (err) {
    log(`[template-review] LLM call failed: ${err.message}`);
    return { html: original, changed: false, issues, applied: false, reason: `LLM call failed: ${err.message}` };
  }
  // The notes are context, not markup: a model that echoes them as a leading comment gets them
  // stripped here, so the guard's size ratio and `changed` compare markup with markup.
  const reviewed = sanitizeTemplate(splitTemplateNotes(stripFences(content)).html.trim());
  const verdict = validateReviewed(original, reviewed, type);
  if (!verdict.ok) {
    log(`[template-review] rejected model output: ${verdict.reason}`);
    return { html: original, changed: false, issues, applied: false, reason: verdict.reason };
  }
  const changed = reviewed !== original.trim();
  const remaining = auditTemplate(reviewed, notes);
  log(`[template-review] applied (${changed ? 'changed' : 'identical'}); audit after: ${remaining.length ? remaining.join(' | ') : 'clean'}`);
  return { html: reviewed, changed, issues, remaining, applied: true };
}
