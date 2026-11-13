// Frontmatter helpers shared by the wiki plugin and Books (index entries are YAML frontmatter +
// a summary). Regex-based and tolerant on purpose: no YAML validation, no type coercion.

// Returns { key: rawStringValue } for simple `key: value` lines between `---` delimiters.
// Unknown keys pass through.
export function parseFrontmatter(content) {
  if (!content || !content.startsWith('---')) return null;
  const closeIdx = content.indexOf('\n---', 4);
  if (closeIdx === -1) return null;
  const block = content.slice(4, closeIdx);
  const out = {};
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// Forcibly overwrite source: and last_updated: in the frontmatter block.
// Strips any existing instances and re-inserts at the top in canonical order,
// preserving all other frontmatter lines verbatim.
export function enforceFrontmatterFields(summary, { source, last_updated }) {
  if (!summary || !summary.startsWith('---')) return summary;
  const closeIdx = summary.indexOf('\n---', 4);
  if (closeIdx === -1) return summary;

  const block = summary.slice(4, closeIdx);
  const rest = summary.slice(closeIdx + 1); // starts with "---\n...body"

  const filtered = block
    .split('\n')
    .filter(line => !/^source\s*:/i.test(line) && !/^last_updated\s*:/i.test(line))
    .join('\n')
    .replace(/^\n+|\n+$/g, '');

  const newBlock = `source: ${source}\nlast_updated: ${last_updated}${filtered ? '\n' + filtered : ''}`;
  return `---\n${newBlock}\n${rest}`;
}
