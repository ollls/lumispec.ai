// One definition of an <applet> block for every place that cuts them out of assistant text:
// the history filter (conversations.js), the Obsidian exporter, and — as a copy, since the
// frontend has no bundler — src/public/js/app.js.
//
// Tolerant of a block whose closing tag is missing or cut short at the very end of the text.
// On 2026-10-31 a 19K-char dashboard ended in `</applet`: the model sampled end-of-sequence
// instead of the final `>`, the strict regex matched nothing, the HTML rendered as sanitized
// markdown (tables kept, styles and scripts stripped), and the raw 19K went back to the model
// as context on every later turn. A closing tag that is the last token of an answer is the
// normal shape for "render this as a dashboard", so one dropped token must not cost the block.
export const APPLET_RE = /<applet\s+type=["']([^"']*)["'][^>]*>([\s\S]*?)(?:<\/applet>|$)/gi;

/** A trailing prefix of `</applet>` (`<`, `</`, … `</applet`) left behind when the closer was cut short. */
const TRAILING_CLOSER_RE = /<(?:\/(?:a(?:p(?:p(?:l(?:e(?:t)?)?)?)?)?)?)?$/i;

/** The body of a matched applet, without surrounding whitespace or a cut-short closing tag. */
export function appletBody(raw) {
  return String(raw).trim().replace(TRAILING_CLOSER_RE, '').trim();
}

/** Replace every applet block in `text` with `fn(type, body)`. */
export function replaceApplets(text, fn) {
  return String(text).replace(APPLET_RE, (_m, type, body) => fn(type, appletBody(body)));
}
