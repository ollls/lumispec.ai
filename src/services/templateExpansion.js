// [template: name] expansion for the chat route: the saved applet HTML plus the instruction
// block the model receives with it. Pure — the lookup is injected so the text is testable.

export const TEMPLATE_TAG_RE = /\[template:\s*([^\]]+)\]/gi;

/**
 * The instruction block for one template.
 *
 * The "sources" sentence exists because the Web Research prompt sets a per-question budget
 * ("Maximum 3 web_search calls and 3 web_fetch calls"), meant for open-ended questions. A
 * template that enumerates its own data sources is not open-ended: on 2026-11-04 the model
 * read the World NEWS template's eight-outlet footer, saw the budget, and deliberated between
 * fetching three outlets and substituting searches for front pages. The template's sources
 * define the task, so the budget yields to them here and nowhere else.
 */
export function templateInstruction(tpl) {
  return `\n\nUse this saved HTML applet template as the EXACT base — output it as an <applet type="${tpl.type}"> block.
Copy the template's HTML, CSS, and JavaScript VERBATIM. Only modify data values, dates, and dynamic content that need updating.
If no fresh data is needed, output the template UNCHANGED.
Do NOT redesign, restyle, or reimagine the template.
Do NOT change colors, dimensions, font choices, CSS properties, class names, IDs, or DOM structure.
If the user's message requests changes, apply ONLY those specific changes to the template.
Fetch fresh data using the appropriate tools first if the content requires it, then populate the template with the new data.
When the template names its data sources (sites, feeds, tickers, files), fetch EVERY one of them — the per-question web_search/web_fetch budget does not apply to a template's own sources. Fetch up to 4 in parallel per round. If a source fails, say so in the output instead of filling it from memory.
\`\`\`html\n${tpl.html}\n\`\`\``;
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
    if (tpl) content = content.replace(match[0], templateInstruction(tpl));
  }
  return content;
}
