// Shared routing predicate: does an assistant message contain fabricated option-chain data?
//
// Lives in its own module because two consumers need one definition — the live guard in
// src/routes/conversations.js and the observation-only predicate vector in src/services/routeLog.js.
// If they drift apart, the route logs stop describing the code they claim to mirror.

// Fields that appear in a real option-chain quote, each with a number attached.
const CHAIN_QUOTE_FIELDS = [
  /\bbid\b[^\n]{0,20}\d/i,
  /\bask\b[^\n]{0,20}\d/i,
  /\b(IV|implied\.?\s?vol\w*)\b[^\n]{0,20}\d/i,
  /\bdelta\b[^\n]{0,20}-?\d/i,
  /\bgamma\b[^\n]{0,20}-?\d/i,
  /\btheta\b[^\n]{0,20}-?\d/i,
  /\bvega\b[^\n]{0,20}-?\d/i,
  /\b(open interest|OI)\b[^\n]{0,20}\d/i,
];
const CHAIN_COLUMN = /\b(strike|bid|ask|IV|implied\.?\s?vol\w*|delta|gamma|theta|vega|open interest|OI)\b/gi;

/**
 * Does this response contain something that reads like an option-chain quote?
 *
 * Two shapes count, and both demand more than a single keyword — the old detector matched any
 * message pairing "premium"/"call" with a number and the word "expires", which caught tax
 * summaries and theta-decay explanations and threw away finished answers (see logs/routes_*.jsonl,
 * 8 firings, all false positives).
 *
 *   (a) prose/row form — one line carrying 2+ quote fields with numbers
 *   (b) table form — a header naming 2+ chain columns, followed by a numeric row
 *
 * Tool-call and think blocks are stripped first: run_python code that reads an optionchains CSV
 * mentions those column names without presenting any data to the user.
 *
 * @returns {string|null} the offending line (trimmed, capped) for logging, or null
 */
export function looksLikeChainQuote(content) {
  const text = content
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/gi, '')
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let fields = 0;
    for (const re of CHAIN_QUOTE_FIELDS) if (re.test(line)) fields++;
    if (fields >= 2) return line.trim().slice(0, 160);

    if (!line.includes('|')) continue;
    const cols = new Set((line.match(CHAIN_COLUMN) || []).map(c => c.toLowerCase()));
    if (cols.size < 2) continue;
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const cells = lines[j].split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length < 3) continue;
      const numeric = cells.filter(c => /^[-+$]?[\d,]+(\.\d+)?%?$/.test(c)).length;
      if (numeric >= 2) return line.trim().slice(0, 160);
    }
  }
  return null;
}
