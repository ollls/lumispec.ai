// conversation_read: what the model wrote earlier in this conversation but can no longer see.
//
// The history rebuild sends each earlier assistant turn as its final text only, with every
// <applet> block replaced by "[Applet: TYPE visualization]" and no tool rounds (reasoning only
// with Retain on). So when the user says "the chart is blank, fix it", the model rewrites from
// its memory of the request, not from the code that failed. Everything is still in the stored
// message; readConversationPart() hands back one slice of it. Pure — the tool passes the conv.

import { APPLET_RE, appletBody } from './applets.js';

export const MAX_APPLETS_CHARS = 40000;   // above this, list the applets and ask for one by index
export const MAX_TOOL_RESULT_CHARS = 3000; // per stored tool result
export const MAX_TOOL_RESULTS = 12;        // newest N of the turn
export const MAX_ONE_TOOL_RESULT_CHARS = 20000; // one result asked for by index (`tool`)
export const MAX_REASONING_CHARS = 12000;  // tail of the turn's reasoning

const textOf = (msg) => (typeof msg.content === 'object' && msg.content ? msg.content.text : msg.content) || '';

function appletsIn(text) {
  return [...String(text).matchAll(APPLET_RE)].map((m, i) => {
    const html = appletBody(m[2]);
    return { applet: i, type: m[1].toLowerCase(), chars: html.length, html };
  });
}

// Tool uses of a turn: a chat turn stores them on the message, a pipeline run per step.
function toolUsesOf(msg) {
  const c = typeof msg.content === 'object' && msg.content ? msg.content : {};
  const out = [...(c.toolUses || [])];
  for (const task of c.taskRun || []) {
    out.push(...(task.toolUses || []));
    for (const sub of task.subtasks || []) out.push(...(sub.toolUses || []));
  }
  return out;
}

function reasoningOf(msg) {
  const c = typeof msg.content === 'object' && msg.content ? msg.content : {};
  const parts = [c.reasoning];
  for (const task of c.taskRun || []) {
    parts.push(task.reasoning);
    for (const sub of task.subtasks || []) parts.push(sub.reasoning);
  }
  return parts.filter(Boolean).join('\n\n');
}

const HAS = {
  applet: (msg) => appletsIn(textOf(msg)).length > 0,
  tools: (msg) => toolUsesOf(msg).length > 0,
  reasoning: (msg) => reasoningOf(msg).length > 0,
};

const NOTHING = {
  applet: 'No applet found in the earlier answers of this conversation.',
  tools: 'No tool results are stored for the earlier answers of this conversation.',
  reasoning: 'No reasoning is stored for the earlier answers of this conversation.',
};

/**
 * @param conv   stored conversation ({ messages })
 * @param what   'applet' | 'tools' | 'reasoning'
 * @param message index into conv.messages; default = the newest assistant message that has `what`
 * @param applet  index of one applet inside that message (what: 'applet')
 * @param tool    index of one tool result inside that message (what: 'tools') — returned in full
 */
export function readConversationPart(conv, { what = 'applet', message, applet, tool } = {}) {
  if (!conv || !Array.isArray(conv.messages)) return { error: 'Conversation not found.' };
  if (!HAS[what]) return { error: `Unknown "what": ${what}. Use "applet", "tools" or "reasoning".` };

  let idx;
  if (message !== undefined && message !== null && message !== '') {
    idx = Number(message);
    const msg = conv.messages[idx];
    if (!Number.isInteger(idx) || !msg) return { error: `No message ${message} in this conversation (it has ${conv.messages.length}).` };
    if (msg.role !== 'assistant') return { error: `Message ${idx} is a ${msg.role} message, not one of your answers.` };
    if (!HAS[what](msg)) return { error: `Message ${idx} has no ${what === 'tools' ? 'tool results' : what}.` };
  } else {
    idx = -1;
    for (let i = conv.messages.length - 1; i >= 0; i--) {
      const msg = conv.messages[i];
      if (msg.role === 'assistant' && HAS[what](msg)) { idx = i; break; }
    }
    if (idx < 0) return { error: NOTHING[what] };
  }
  const msg = conv.messages[idx];

  if (what === 'applet') {
    const all = appletsIn(textOf(msg));
    if (applet !== undefined && applet !== null && applet !== '') {
      const one = all[Number(applet)];
      if (!one) return { error: `Message ${idx} has ${all.length} applet(s); there is no applet ${applet}.` };
      return { what, message: idx, count: all.length, applets: [one], note: APPLET_NOTE };
    }
    const total = all.reduce((n, a) => n + a.chars, 0);
    if (all.length > 1 && total > MAX_APPLETS_CHARS) {
      return {
        what, message: idx, count: all.length,
        applets: all.map(({ html, ...meta }) => meta),
        note: `These applets total ${total} chars. Call again with "applet": <index> to read one.`,
      };
    }
    return { what, message: idx, count: all.length, applets: all, note: APPLET_NOTE };
  }

  if (what === 'tools') {
    const all = toolUsesOf(msg);
    const text = (t) => (typeof t.result === 'string' ? t.result : JSON.stringify(t.result));
    // One result by index, in full: the list view below cuts each to 3,000 chars and shows only
    // the newest 12, which can be exactly the result the user is asking about.
    if (tool !== undefined && tool !== null && tool !== '') {
      const i = Number(tool);
      const t = Number.isInteger(i) ? all[i] : undefined;
      if (!t) return { error: `Message ${idx} has ${all.length} tool result(s), numbered 0–${all.length - 1}; there is no tool ${tool}.` };
      const result = text(t);
      return result.length > MAX_ONE_TOOL_RESULT_CHARS
        ? { what, message: idx, count: all.length, tool: i, name: t.name, result: result.slice(0, MAX_ONE_TOOL_RESULT_CHARS), truncatedFrom: result.length }
        : { what, message: idx, count: all.length, tool: i, name: t.name, result };
    }
    const first = Math.max(0, all.length - MAX_TOOL_RESULTS);
    const shown = all.slice(first).map((t, k) => {
      const result = text(t);
      return result.length > MAX_TOOL_RESULT_CHARS
        ? { tool: first + k, name: t.name, result: result.slice(0, MAX_TOOL_RESULT_CHARS), truncatedFrom: result.length }
        : { tool: first + k, name: t.name, result };
    });
    const out = { what, message: idx, count: all.length, shown: shown.length, toolUses: shown };
    if (first > 0 || shown.some((t) => t.truncatedFrom)) out.note = 'Call again with "tool": <index> to read one result in full.';
    return out;
  }

  const reasoning = reasoningOf(msg);
  return reasoning.length > MAX_REASONING_CHARS
    ? { what, message: idx, reasoning: reasoning.slice(-MAX_REASONING_CHARS), truncatedFrom: reasoning.length, note: 'Showing the end of the reasoning.' }
    : { what, message: idx, reasoning };
}

const APPLET_NOTE = 'This is the exact code you wrote. Find the cause in it, then output the complete corrected applet — change only what is needed.';
