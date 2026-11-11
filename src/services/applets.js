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

// ── History placeholder ─────────────────────────────────────────────────────────────────────
// The history rebuild cuts each earlier applet out of the model's context and leaves one line in
// its place. Until 2026-11-10 that line was "[Applet: html visualization]" — short, bracketed,
// and shaped like something an answer could contain. In a conversation with three earlier
// applets the model, asked for a fourth, answered with that exact line and a description of the
// chart it had not written: nothing rendered and nothing flagged it. The line now says what it
// is and that it must not be written, and echoedAppletPlaceholder() catches an answer that
// writes either form anyway so the chat loop can ask once for the real block.
const PLACEHOLDER_MARK = 'its code is not kept in this history';

/** What an earlier applet looks like in the history sent to the model. Must not contain an
 *  applet tag itself: echoed into an answer it would parse as an (empty) applet. */
export function appletPlaceholder(type) {
  return `[An applet (${type}) was displayed here; ${PLACEHOLDER_MARK}. Never write this line yourself — to show an applet, output the complete applet block with its full code.]`;
}

const OLD_PLACEHOLDER_LINE_RE = /^[ \t>*_`-]*\[Applet: (?:svg|chartjs|html) visualization\][ \t*_`]*$/im;

/**
 * True when an answer writes the history placeholder where an applet should be: the old or the
 * new form, and no real applet block anywhere in the answer. The old form must stand on a line
 * of its own with a real type, so prose that quotes "[Applet: TYPE visualization]" does not trip it.
 */
export function echoedAppletPlaceholder(content) {
  const text = String(content || '');
  if (/<applet\s+type=/i.test(text)) return false;
  return text.includes(PLACEHOLDER_MARK) || OLD_PLACEHOLDER_LINE_RE.test(text);
}

/** The retry instruction for an answer caught by echoedAppletPlaceholder(). */
export const APPLET_PLACEHOLDER_REPAIR =
  'Your answer contains the history placeholder for an applet instead of an applet. That line is only how your EARLIER applets appear in this history — it renders nothing, so the user sees no visualization. '
  + 'Write your answer again with the complete <applet type="…">…</applet> block (full HTML, nothing omitted). If you need the code of an earlier applet, call conversation_read first.';
