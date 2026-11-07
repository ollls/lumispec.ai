import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditTemplate, validateReviewed, stripFences, reviewUserMessage, reviewTemplateHtml, sanitizeTemplate, contractIssues, scriptSyntaxError, REVIEW_SYSTEM_PROMPT,
} from '../src/services/templateReview.js';

// The AMD intraday applet as it was saved on 2026-11-06 14:44 — data placeholder never filled,
// date baked into the heading, no error path, no resize message.
const AMD_RAW = `<!DOCTYPE html>
<html><head>
<script src="/lib/chart.min.js"></script>
<style>body { margin: 0; padding: 16px; background: #1a1a2e; color: #e0e0e0; }</style>
</head><body>
<h2>AMD — Intraday, Friday Nov 6, 2026</h2>
<div class="sub"><span class="stat">Last <b id="last"></b></span></div>
<canvas id="chart" style="max-height:420px"></canvas>
<script>
const DATA = __DATA__;
const labels = DATA.map(d => d[0]);
const closes = DATA.map(d => d[1]);
document.getElementById('last').textContent = '$' + closes[closes.length-1].toFixed(2);
new Chart(document.getElementById('chart'), {
  type: 'line',
  data: { labels, datasets: [{ label: 'Price', data: closes, borderColor: '#4a9eff' }] },
  options: { responsive: true }
});
</script>
</body></html>`;

// What the manual fix turned it into (abridged): discovers its files, computes the title, reports errors, resizes.
const AMD_FIXED = `<!DOCTYPE html>
<html><head>
<script src="/lib/chart.min.js"></script>
<style>body { margin: 0; padding: 16px; background: #1a1a2e; color: #e0e0e0; } #err { color: #ef4444; }</style>
</head><body>
<h2 id="title">Loading…</h2>
<div class="sub"><span class="stat">Last <b id="last">—</b></span></div>
<div id="err"></div>
<div class="wrap"><canvas id="chart"></canvas></div>
<script>
const $ = id => document.getElementById(id);
function fail(msg) { $('err').textContent = msg; }
async function main() {
  let files;
  try { files = await (await fetch('/api/files?match=amd')).json(); }
  catch (e) { return fail('Could not list data files: ' + e.message); }
  if (!Array.isArray(files) || !files.length) return fail('No AMD data files found in project directory.');
  const parsed = (await Promise.all(files.map(async f => {
    try { return await (await fetch('/files/' + f)).json(); } catch { return null; }
  }))).filter(Boolean);
  const bars = parsed.find(x => Array.isArray(x) && x.length);
  if (!bars) return fail('No intraday bar data found.');
  const labels = bars.map(d => d[0]);
  const closes = bars.map(d => d[1]);
  $('title').textContent = 'AMD — Intraday, ' + new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('last').textContent = '$' + closes[closes.length - 1].toFixed(2);
  new Chart($('chart'), {
    type: 'line',
    data: { labels, datasets: [{ label: 'Price', data: closes, borderColor: '#4a9eff' }] },
    options: { responsive: true, maintainAspectRatio: false }
  });
  window.parent.postMessage({ type: 'resize', height: document.body.scrollHeight }, '*');
}
main();
</script>
</body></html>`;

const fakeLLM = (reply) => async () => ({ content: reply });

test('audit names every defect the AMD save had', () => {
  const issues = auditTemplate(AMD_RAW);
  const text = issues.join('\n');
  assert.match(text, /unresolved placeholder "__DATA__"/);
  assert.match(text, /date "Friday Nov 6, 2026" written into the markup/);
  assert.match(text, /no resize postMessage/);
  assert.equal(issues.filter(i => i.includes('fetch() without')).length, 0, 'no fetch to complain about');
});

test('the fixed template audits clean', () => {
  assert.deepEqual(auditTemplate(AMD_FIXED), []);
});

test('audit flags a hardcoded dataset with no fetch, and Python literals', () => {
  const html = `<html><body><canvas id="c"></canvas><script>
const DATA = [[1,2.5,3],[4,5.5,6],[7,8.5,9],[10,11.5,12],[13,14.5,15]];
const ok = x === None;
new Chart(document.getElementById('c'), { data: DATA });
window.parent.postMessage({type:'resize',height:1},'*');
</script></body></html>`;
  const text = auditTemplate(html).join('\n');
  assert.match(text, /numbers hardcoded in array literals and no fetch/);
  assert.match(text, /Python literals/);
});

test('audit does not mistake Chart.js dataset configuration for hardcoded data', () => {
  const html = `<html><body><canvas id="c"></canvas><script>
fetch('/api/files?match=amd').then(r => r.json()).then(files => draw(files)).catch(e => show(e));
function draw(rows) {
  new Chart(document.getElementById('c'), { data: { datasets: [
    { label: 'Price', data: rows.map(d => d[1]), borderColor: '#4a9eff', backgroundColor: 'rgba(74,158,255,0.15)', fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2 },
    { label: 'Volume', data: rows.map(d => d[2]), backgroundColor: 'rgba(124,58,237,0.45)', yAxisID: 'y1' }
  ] } });
  window.parent.postMessage({type:'resize',height:document.body.scrollHeight},'*');
}
</script></body></html>`;
  assert.deepEqual(auditTemplate(html), []);
});

test('audit flags a fetch without a catch and an empty select', () => {
  const html = `<html><body><select id="s"></select><script>
fetch('/files/x.csv').then(r => r.text()).then(t => render(t));
window.parent.postMessage({type:'resize',height:1},'*');
</script></body></html>`;
  const text = auditTemplate(html).join('\n');
  assert.match(text, /fetch\(\) without any catch/);
  assert.match(text, /empty <select>/);
});

test('the user message leads with the audit so the model fixes what we know is wrong', () => {
  const msg = reviewUserMessage('<html></html>', ['a', 'b']);
  assert.ok(msg.startsWith('Automatic audit of this template found:\n- a\n- b\n'));
  assert.ok(msg.endsWith('<html></html>'));
  assert.equal(reviewUserMessage('<html></html>', []), '<html></html>');
});

test('stripFences handles bare fences, a prose lead-in, and clean HTML', () => {
  assert.equal(stripFences('```html\n<html>x</html>\n```'), '<html>x</html>');
  assert.equal(stripFences('Here is the improved template:\n```html\n<html>x</html>\n```\n'), '<html>x</html>');
  assert.equal(stripFences('  <html>x</html>  '), '<html>x</html>');
});

test('validateReviewed accepts the real fix', () => {
  assert.deepEqual(validateReviewed(AMD_RAW, AMD_FIXED, 'chartjs'), { ok: true });
});

test('validateReviewed rejects answers that cannot replace the template', () => {
  const r = (out, type = 'chartjs') => validateReviewed(AMD_RAW, out, type).reason;
  assert.equal(r(''), 'empty response');
  assert.equal(r('Sure! Here is the improved template with fetch.'), 'not HTML');
  assert.match(r('<html><body><script>const DATA = __DATA__;</script></body></html>'), /placeholder still present/);
  assert.equal(r('<html><body><p>chart</p></body></html>'), 'script block lost');
  assert.equal(r(AMD_FIXED.replace('</html>', '')), 'document cut short (no </html>)');
  assert.equal(r(AMD_FIXED.replace('new Chart(', 'draw(')), 'Chart.js instantiation lost');
  assert.match(r('<html><body><script>new Chart(1)</script></body></html>'), /% of the original size/);
  assert.match(r(AMD_FIXED + '<script>'), /unbalanced <script> tags|output is/);
  assert.equal(r('```html\n' + AMD_FIXED + '\n```'), 'markdown fence left in output');
});

test('reviewTemplateHtml applies a good answer and reports what it fixed', async () => {
  const log = [];
  const out = await reviewTemplateHtml(AMD_RAW, 'chartjs', { complete: fakeLLM('```html\n' + AMD_FIXED + '\n```'), log: l => log.push(l) });
  assert.equal(out.applied, true);
  assert.equal(out.changed, true);
  assert.equal(out.html, AMD_FIXED);
  assert.ok(out.issues.length >= 3);
  assert.deepEqual(out.remaining, []);
  assert.ok(log.some(l => l.includes('audit after: clean')));
});

test('reviewTemplateHtml keeps the original when the model answer is unusable', async () => {
  const out = await reviewTemplateHtml(AMD_RAW, 'chartjs', { complete: fakeLLM('I cannot help with that.') });
  assert.equal(out.applied, false);
  assert.equal(out.html, AMD_RAW);
  assert.equal(out.reason, 'not HTML');
});

test('reviewTemplateHtml keeps the original when the LLM call throws', async () => {
  const out = await reviewTemplateHtml(AMD_RAW, 'chartjs', { complete: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(out.applied, false);
  assert.equal(out.html, AMD_RAW);
  assert.match(out.reason, /LLM call failed: ECONNREFUSED/);
});

test('reviewTemplateHtml sends the audit to the model and sanitizes the answer', async () => {
  let seen;
  const reply = AMD_FIXED.replace("if (!bars) return fail(", "if (bars === None) return fail(");
  const out = await reviewTemplateHtml(AMD_RAW, 'chartjs', { complete: async (messages) => { seen = messages; return { content: reply }; } });
  assert.equal(seen[0].role, 'system');
  assert.match(seen[1].content, /^Automatic audit of this template found:/);
  assert.ok(seen[1].content.includes('__DATA__'));
  assert.ok(out.html.includes('bars === null'), 'sanitizer ran on the model output');
});

test('sanitizeTemplate still does its deterministic fixes', () => {
  const html = sanitizeTemplate('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><script>if (x === None) y = True;</script>');
  assert.ok(html.includes('/lib/chart.min.js'));
  assert.ok(html.includes('x === null'));
  assert.ok(html.includes('y = true;'));
});

// ── Notes vs. markup (2026-11-07: the author's notes live apart from the HTML) ───────────────

const CHPY_NOTES = `ASSISTANT: create the data files first. Do not emit the applet until both exist:
  chpy_smh_sox.csv        header exactly: date,chpy,smh,sox   (lowercase; daily closes)
  chpy_smh_sox_meta.json  {"title":"CHPY vs SMH vs SOX"}
Fetch exactly these three symbols. Then output this template VERBATIM.`;

const CHPY_HTML = `<!DOCTYPE html>\n<html><body><div id="err"></div><canvas id="chart"></canvas><script>
const SERIES = ['chpy', 'smh', 'sox'];
const DATA_MATCH = 'chpy_smh_sox';
const META_MATCH = 'chpy_smh_sox_meta';
fetch('/api/files?match=' + DATA_MATCH).then(r => r.json()).then(f => new Chart(1)).catch(e => { document.getElementById('err').textContent = e.message; });
window.parent.postMessage({ type:'resize', height: document.body.scrollHeight }, '*');
</script></body></html>`;

test('contractIssues is quiet when the HTML selects every file and column the notes name', () => {
  assert.deepEqual(contractIssues(CHPY_HTML, CHPY_NOTES), []);
  assert.deepEqual(contractIssues(CHPY_HTML, ''), []);
  assert.deepEqual(auditTemplate(CHPY_HTML, CHPY_NOTES), []);
  // one noted file selected by a short keyword (the AMD template's ?match=amd) is a reference
  assert.deepEqual(contractIssues("<script>fetch('/api/files?match=amd')</script>", 'write amd_intraday.json first'), []);
});

test('contractIssues flags a noted file the HTML never looks for, and a promised column it never mentions', () => {
  const drifted = CHPY_HTML.replace("'chpy_smh_sox_meta'", "'semi_meta'").replace("'sox'", "'soxx'");
  const text = contractIssues(drifted, CHPY_NOTES).join('\n');
  assert.match(text, /"chpy_smh_sox_meta\.json" but the HTML never references it/);
  assert.match(text, /column\(s\) sox but the HTML never mentions them/);
  assert.ok(!text.includes('chpy_smh_sox.csv'), 'the CSV is still selected by its match keyword');
  // the audit carries the same findings
  assert.ok(auditTemplate(drifted, CHPY_NOTES).some(i => i.includes('chpy_smh_sox_meta.json')));
});

test('the user message puts the notes first, as context only, ahead of the audit and the HTML', () => {
  const msg = reviewUserMessage('<html></html>', ['a'], 'build x.csv first');
  assert.ok(msg.startsWith('Template notes — '));
  assert.ok(msg.includes('must NOT appear in your output'));
  assert.ok(msg.indexOf('build x.csv first') < msg.indexOf('Automatic audit of this template found:\n- a'));
  assert.ok(msg.endsWith('<html></html>'));
  // no notes, no audit → bare HTML, as before
  assert.equal(reviewUserMessage('<html></html>', [], ''), '<html></html>');
  assert.equal(reviewUserMessage('<html></html>', [], undefined), '<html></html>');
});

test('reviewTemplateHtml hands the notes to the model and strips them if they come back as a comment', async () => {
  let seen;
  const echoed = '<!DOCTYPE html>\n<!-- ' + CHPY_NOTES + ' -->' + CHPY_HTML.replace('<!DOCTYPE html>', '');
  const out = await reviewTemplateHtml(CHPY_HTML, 'html', { notes: CHPY_NOTES, complete: async (messages) => { seen = messages; return { content: echoed }; } });
  assert.ok(seen[1].content.startsWith('Template notes — '));
  assert.ok(seen[1].content.includes('chpy_smh_sox_meta.json'));
  assert.equal(out.applied, true);
  assert.ok(!out.html.includes('<!--'), 'echoed notes stripped from the answer');
  assert.equal(out.html, CHPY_HTML);
  assert.equal(out.changed, false);
  assert.deepEqual(out.remaining, []);
});

// ── Script parse guard (2026-11-07: the review wrote `$/);` into a working regex literal) ─────

test('scriptSyntaxError names the first script that does not parse and is quiet on working code', () => {
  assert.equal(scriptSyntaxError(CHPY_HTML), null);
  assert.equal(scriptSyntaxError('<div>no script</div>'), null);
  const broken = CHPY_HTML.replace("const SERIES = ['chpy', 'smh', 'sox'];", "const suffix = /(_n|_norm|_normalized|_idx)$/);");
  assert.match(scriptSyntaxError(broken), /^line 2: Unexpected token '\)'/);
  // external scripts are not parsed, only inline ones
  assert.equal(scriptSyntaxError('<script src="/lib/chart.min.js"></script><script>ok()</script>'), null);
});

test('validateReviewed rejects an answer whose script no longer parses, unless the original never did', () => {
  const broken = CHPY_HTML.replace("const SERIES = ['chpy', 'smh', 'sox'];", "const suffix = /(_n|_norm|_normalized|_idx)$/);");
  const v = validateReviewed(CHPY_HTML, broken, 'html');
  assert.equal(v.ok, false);
  assert.match(v.reason, /^script does not parse \(line 2: Unexpected token '\)'\)/);
  assert.equal(validateReviewed(CHPY_HTML, CHPY_HTML, 'html').ok, true);
  assert.equal(validateReviewed(broken, broken, 'html').ok, true, 'a broken original is not held to the parse check');
});

test('reviewTemplateHtml keeps the original when the model breaks the JavaScript', async () => {
  const broken = CHPY_HTML.replace("const SERIES = ['chpy', 'smh', 'sox'];", "const suffix = /(_n|_norm|_normalized|_idx)$/);");
  const out = await reviewTemplateHtml(CHPY_HTML, 'html', { notes: CHPY_NOTES, complete: fakeLLM(broken) });
  assert.equal(out.applied, false);
  assert.equal(out.html, CHPY_HTML);
  assert.match(out.reason, /script does not parse/);
});

// ── Clock-driven templates are not "static" (2026-11-07: Beautiful Watch got an invented fetch) ──

const WATCH = `<!DOCTYPE html><html><body><div class="brand">Lumispec</div><div id="timeDisplay"></div><script>
function updateWatch() { document.getElementById('timeDisplay').textContent = new Date().toLocaleTimeString(); }
updateWatch();
setInterval(updateWatch, 50);
window.parent.postMessage({type:'resize',height:document.body.scrollHeight},'*');
</script></body></html>`;

test('a template driven by the clock is not audited as static', () => {
  assert.deepEqual(auditTemplate(WATCH), []);
  const still = '<html><body><p>Hello</p><script>document.body.style.color = "red"; window.parent.postMessage({type:"resize",height:1},"*");</script></body></html>';
  assert.match(auditTemplate(still).join('\n'), /^static: no data loading and nothing time-driven/m);
});

test('the review rules forbid inventing a data source', () => {
  assert.ok(REVIEW_SYSTEM_PROMPT.includes('Do NOT add a data source the template never had'));
});
