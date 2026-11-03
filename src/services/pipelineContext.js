// Task-pipeline hand-off: the previous step's output, clipped to MAX_PREV_RESULT_CHARS.
//
// A subtask group's outputs are joined under "## <subtask>" headers before the cap applies,
// so a wide fan-out (13 news sites at 3–5.6K chars each = 60K, 2026-11-03) loses its last
// siblings whole. The cut used to be announced only by a "[...truncated from X chars]" line
// at the bottom of the model's user message — the model built a dashboard from the 7½
// outlets it had and said nothing. truncatePrevResult() names what was lost so the model can
// say so, and the caller logs, streams and stores the same facts.

const HEADER_RE = /^## (.+)$/gm;

/**
 * Clip `prevResult` to `cap` chars. Pure.
 * @returns {{ text: string, truncated: boolean, from: number, cap: number,
 *             cut: string|null, dropped: string[], notice: string|null }}
 *   text     — what to hand the model (the notice, the head, the tail marker)
 *   cut      — the section header the cut landed inside, if the output had sections
 *   dropped  — section headers that start at or after the cap (lost entirely)
 *   notice   — one-line human summary, null when nothing was cut
 */
export function truncatePrevResult(prevResult, cap) {
  const from = prevResult.length;
  if (from <= cap) {
    return { text: prevResult, truncated: false, from, cap, cut: null, dropped: [], notice: null };
  }

  const sections = [];
  for (const m of prevResult.matchAll(HEADER_RE)) sections.push({ name: m[1].trim(), at: m.index });
  const kept = sections.filter(s => s.at < cap);
  const dropped = sections.filter(s => s.at >= cap).map(s => s.name);
  // The last section that starts before the cap is the one the cut lands inside — unless the
  // output has no sections at all (a flat step's prose), in which case there is nothing to name.
  const cut = kept.length ? kept[kept.length - 1].name : null;

  const parts = [`Previous output truncated: showing the first ${cap.toLocaleString()} of ${from.toLocaleString()} chars`];
  if (cut) parts.push(`cut mid-section: "${cut}"`);
  if (dropped.length) parts.push(`dropped entirely (${dropped.length}): ${dropped.map(d => `"${d}"`).join(', ')}`);
  const notice = parts.join(' — ');

  const head = `> ⚠ **${notice}.** Work with what is here. State in your output which sections were missing or incomplete — do not present a partial set as the whole.`;
  const text = `${head}\n\n${prevResult.slice(0, cap)}\n\n[...truncated from ${from} chars; ${dropped.length} section(s) dropped${cut ? `, cut inside "${cut}"` : ''}]`;

  return { text, truncated: true, from, cap, cut, dropped, notice };
}
