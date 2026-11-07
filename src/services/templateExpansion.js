// [template: name] expansion for the chat route: the saved applet HTML plus the instruction
// block the model receives with it. Pure — the lookup is injected so the text is testable.

export const TEMPLATE_TAG_RE = /\[template:\s*([^\]]+)\]/gi;

// ── Template notes ──────────────────────────────────────────────────────────────────────────
// A template's author writes instructions for the assistant as HTML comments ahead of the markup
// (which files to build, which symbols to fetch, what never to change). Those comments used to
// travel inside `html`, so the model copied them into every applet it emitted: 1,500 chars of the
// CHPY template's 13K were comment, and the longer the verbatim copy, the likelier a slip — on
// 2026-11-07 one stray `)` in a regex literal killed the applet's script. The notes now live in
// `tpl.notes`, shown to the model outside the code fence, and the HTML it copies is only HTML.

const LEADING_COMMENTS_RE = /^(\s*<!DOCTYPE[^>]*>)?((?:\s*<!--[\s\S]*?-->)+)[ \t]*\r?\n?/i;

/** Drop the common indentation of every line after the first (comment bodies are often indented to the `<!--`). */
function dedent(text) {
  const lines = text.split('\n');
  const rest = lines.slice(1).filter(l => l.trim());
  if (!rest.length) return text;
  const indent = Math.min(...rest.map(l => l.match(/^[ \t]*/)[0].length));
  return [lines[0], ...lines.slice(1).map(l => l.slice(Math.min(indent, l.match(/^[ \t]*/)[0].length)))].join('\n');
}

/**
 * Split the author's notes off a template: every `<!-- … -->` before the markup (an optional
 * doctype may precede them). Returns `{ notes, html }` — `notes` is the comment text, dedented
 * and joined by blank lines, `''` when there is none; `html` keeps the doctype and everything after.
 */
export function splitTemplateNotes(html) {
  const src = html || '';
  const m = LEADING_COMMENTS_RE.exec(src);
  if (!m || !m[2]) return { notes: '', html: src };
  const notes = [...m[2].matchAll(/<!--([\s\S]*?)-->/g)]
    .map(c => dedent(c[1].replace(/^[ \t]*\r?\n/, '')).trim())
    .filter(Boolean)
    .join('\n\n');
  const doctype = m[1] ? m[1].trim() + '\n' : '';
  return { notes, html: doctype + src.slice(m[0].length) };
}

/** The notes of a template record plus any still embedded in its HTML (records saved before `notes` existed). */
export function templateNotes(tpl) {
  const { notes: inline, html } = splitTemplateNotes(tpl.html);
  return { notes: [tpl.notes, inline].filter(n => n && n.trim()).join('\n\n'), html };
}

/**
 * The template as a file: the notes back in a leading comment (after the doctype, where the
 * author put them) so `template_save` round-trips through `splitTemplateNotes`.
 */
export function renderTemplateFile(tpl) {
  const { notes, html } = templateNotes(tpl);
  if (!notes) return html;
  const comment = `<!--\n${notes}\n-->\n`;
  const dt = /^\s*<!DOCTYPE[^>]*>\r?\n?/i.exec(html);
  return dt ? dt[0].trimEnd() + '\n' + comment + html.slice(dt[0].length) : comment + html;
}

/**
 * The instruction block for one template.
 *
 * The "sources" sentence exists because the Web Research prompt sets a per-question budget
 * ("Maximum 3 web_search calls and 3 web_fetch calls"), meant for open-ended questions. A
 * template that enumerates its own data sources is not open-ended: on 2026-11-04 the model
 * read the World NEWS template's eight-outlet footer, saw the budget, and deliberated between
 * fetching three outlets and substituting searches for front pages. The template's sources
 * define the task, so the budget yields to them here and nowhere else.
 *
 * With no notes the text is byte-identical to the pre-notes version.
 */
export function templateInstruction(tpl) {
  const { notes, html } = templateNotes(tpl);
  const notesBlock = notes
    ? `\nTemplate notes — the author's instructions to you. They are NOT part of the HTML: follow them, and do not copy them into the applet.\n${notes}\n`
    : '';
  return `\n\nUse this saved HTML applet template as the EXACT base — output it as an <applet type="${tpl.type}"> block.
Copy the template's HTML, CSS, and JavaScript VERBATIM. Only modify data values, dates, and dynamic content that need updating.
If no fresh data is needed, output the template UNCHANGED.
Do NOT redesign, restyle, or reimagine the template.
Do NOT change colors, dimensions, font choices, CSS properties, class names, IDs, or DOM structure.
If the user's message requests changes, apply ONLY those specific changes to the template.
Fetch fresh data using the appropriate tools first if the content requires it, then populate the template with the new data.
When the template names its data sources (sites, feeds, tickers, files), fetch EVERY one of them — the per-question web_search/web_fetch budget does not apply to a template's own sources. Fetch up to 4 in parallel per round. If a source fails, say so in the output instead of filling it from memory.
${notesBlock}\`\`\`html\n${html}\n\`\`\``;
}

/**
 * Replace every [template: name] tag in `content` with the template's instruction block.
 * Unknown names are left in place. `log` receives one line per tag.
 */
export function expandTemplateTags(content, getTemplateByName, log = () => {}) {
  for (const match of [...content.matchAll(TEMPLATE_TAG_RE)]) {
    const tplName = match[1].trim();
    const tpl = getTemplateByName(tplName);
    log(`[template] expanding "${tplName}" → ${tpl ? `found (${tpl.html.length} chars)` : 'NOT FOUND'}`);
    // Replacement as a function: a string replacement interprets `$'`, `$&`, `` $` `` and `$n`
    // as patterns, and a template with `'$' + v` in its script lost both dollar signs on
    // 2026-11-07 — the model copied the result verbatim and the applet died on a SyntaxError.
    if (tpl) content = content.replace(match[0], () => templateInstruction(tpl));
  }
  return content;
}
