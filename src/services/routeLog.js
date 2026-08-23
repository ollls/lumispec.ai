// Router decision logger — pure observation, no behavior change.
//
// Both tool loops (chat: src/routes/conversations.js, pipeline: src/routes/taskProcessor.js)
// decide the next edge with a short-circuiting if-chain, so only the winning predicate is
// ever observable. This module evaluates ALL predicates and records the full vector next to
// the edge the live code actually took, so we can measure predicate overlap and chat-vs-pipeline
// drift before extracting route(). See GRAPH_EXPLORATION.md.
//
// Gated behind ROUTE_LOG=1. Failures are swallowed — a logger must never break a chat round.

import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { looksLikeChainQuote } from './chainQuote.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = resolve(__dirname, '../../logs');

// Predicates that route somewhere other than the fallthrough. `applet` is excluded — it is a
// modifier on bareJson/malformedTag, not an edge of its own.
const FIRED_KEYS = ['repeatLimit', 'missingChains', 'fabricatedGreeks', 'bareJson', 'malformedTag'];

/**
 * Evaluate every routing predicate against the current round.
 *
 * Mirrors the live conditions verbatim:
 *   toolCalls        conversations.js:300 / taskProcessor.js:370
 *   repeatLimit      conversations.js:316 / taskProcessor.js:383
 *   missingChains    conversations.js:508  (chat only)
 *   fabricatedGreeks conversations.js:520  (chat only, via services/chainQuote.js)
 *   bareJson         conversations.js:491 / taskProcessor.js:437
 *   malformedTag     conversations.js:497 / taskProcessor.js:442
 *
 * The two finance predicates are evaluated in BOTH loops even though only chat acts on them.
 * Records with `loop:"pipeline"`, `missingChains:true`, `edge:"end"` are the drift.
 */
export function evalPredicates({
  content = '',
  toolCallCount = 0,
  callSigs = [],
  sigCounts = {},
  maxRepeats = 3,
  hadChainData = false,
  hadExpiryCall = false,
  toolUseCount = 0,
  financeEnabled = false,
  round = 0,
  maxRounds = 20,
}) {
  const applet = /<applet[\s>]/i.test(content);

  // Both finance guards share this precondition (conversations.js:469, :476)
  const financeGuardable = financeEnabled && !hadChainData && round < maxRounds - 1;

  // fabricatedGreeks additionally requires that nothing was fetched this turn — an answer grounded
  // in any tool result is not fabrication. See services/chainQuote.js for the detector itself.
  const looksLikeOptionData = !!looksLikeChainQuote(content);

  return {
    toolCalls: toolCallCount,
    repeatLimit: callSigs.some(sig => (sigCounts[sig] || 0) > maxRepeats),
    missingChains: financeGuardable && hadExpiryCall,
    fabricatedGreeks: financeGuardable && toolUseCount === 0 && looksLikeOptionData,
    bareJson: !applet && /\{"name"\s*:\s*"/.test(content),
    malformedTag: !applet && /<tool_call/i.test(content),
    applet,
  };
}

function firedCount(pred) {
  let n = pred.toolCalls > 0 ? 1 : 0;
  for (const key of FIRED_KEYS) if (pred[key]) n++;
  return n;
}

/**
 * Append one routing decision as a JSONL record.
 *
 * Content policy: full content is kept only for records worth replaying — any edge other than
 * the two common ones, or any round where 2+ predicates fired. Otherwise a length + sha stands
 * in. Content is never truncated: every predicate regex can match anywhere in the string, so a
 * truncated record would not replay faithfully.
 */
export async function logRouteDecision({
  run, loop, step = null, round, edge, reason = null, pred, state = {}, content = '',
}) {
  if (!config.routeLog) return;
  try {
    const ts = new Date().toISOString();
    const rec = {
      ts,
      run,
      loop,
      step,
      round,
      pred,
      edge,
      reason,
      state: { ...state, contentLen: content.length },
    };
    if ((edge !== 'tools' && edge !== 'end') || firedCount(pred) >= 2) {
      rec.content = content;
    } else {
      rec.contentSha = createHash('sha256').update(content).digest('hex').slice(0, 16);
    }
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(join(LOG_DIR, `routes_${ts.split('T')[0]}.jsonl`), JSON.stringify(rec) + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[routeLog] failed: ${err.message}`);
  }
}
