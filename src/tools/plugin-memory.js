// Memories plugin — facts the user asked the assistant to keep across conversations.
// See docs/MEMORY.md; storage and the prompt block live in ../services/memory.js.
//
// While the plugin is on, every memory has one line in a "## Memories" block at the END of the
// system prompt (the `promptTail` hook), so each request sees them with no search round, and
// saving one invalidates the llama KV cache only from that block on. Nothing is ever saved unless
// the user asks: `memory save` and `memory forget` always go through the approval prompt, and
// Autorun does not skip it — a fetched page that says "remember this" must not be able to plant a
// line in every later conversation.
//
// Session color: a memory may carry one (saved only when the user asks for it). It is ignored
// unless "Only memories matching the chat color" is on; then a tagged memory shows only in chats
// of that color, and untagged memories still show everywhere.

import { readPluginConfig } from './index.js';
import config from '../config.js';
import * as memory from '../services/memory.js';

const GROUP = 'memory';
export const DEFAULTS = {
  enabled: false,
  colorMatch: false, // hide color-tagged memories from chats of another color
  indexMaxChars: memory.MAX_INDEX_CHARS, // size of the memory list in the system prompt
};

// promptTail/cardStatus are synchronous: the config is cached, the files are read on each call.
const cache = { cfg: { ...DEFAULTS } };

async function refresh() {
  cache.cfg = { ...DEFAULTS, ...((await readPluginConfig())[GROUP] || {}) };
}

async function confirm(context, text) {
  if (typeof context?.confirmFn !== 'function') return { error: 'This needs the user\'s approval, and no approval prompt is available in this context.' };
  const ok = await context.confirmFn(text);
  return ok ? null : { error: 'The user declined.' };
}

const view = (m) => ({ name: m.name, color: m.color || null, savedOn: (m.updated || m.created || '').slice(0, 10), text: m.text });

function listMarkdown(list) {
  if (!list.length) return '**Memories** — none saved yet.';
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  const rows = list.map(m => `| ${esc(m.name)} | ${m.color || 'N/A'} | ${(m.updated || '').slice(0, 10) || '—'} | ${esc(m.text.length > 160 ? m.text.slice(0, 160) + '…' : m.text)} |`);
  return `**Memories** (${list.length})\n\n| Name | Color | Saved | Text |\n|---|---|---|---|\n${rows.join('\n')}`;
}

export async function runMemoryTool(args = {}, context = {}, root = memory.MEMORY_ROOT) {
  const action = String(args.action || 'list').toLowerCase();
  const list = memory.listMemories(root);

  if (action === 'list') {
    return { count: list.length, memories: list.map(m => ({ ...view(m), color: m.color || 'N/A' })), _markdown: listMarkdown(list) };
  }

  if (action === 'read') {
    const r = memory.resolveMemory(args.name, list);
    return r.error ? r : view(r.memory);
  }

  if (action === 'save' || action === 'update' || action === 'add') {
    const c = memory.resolveColorArg(args.color, context.session);
    if (c.error) return { error: c.error };
    const name = String(args.name || '').replace(/\s+/g, ' ').trim();
    const text = String(args.text || '').trim();
    if (!name || !text) return { error: 'save needs "name" (a short title) and "text" (the fact to remember).' };
    const old = list.find(m => m.id === memory.slugify(name));
    const color = c.color === undefined ? (old?.color || null) : c.color;
    const scope = color ? ` — only for ${color} chats` : '';
    const denied = await confirm(context, `${old ? 'Update' : 'Save'} memory "${name}"${scope}:\n${text}${old ? `\n\n(replaces: ${old.text})` : ''}`);
    if (denied) return denied;
    try {
      const { memory: saved, existed } = memory.saveMemory({ name, text, description: args.description, color: c.color }, root);
      return { saved: true, updated: existed, ...view(saved) };
    } catch (err) {
      return { error: err.message };
    }
  }

  if (action === 'forget' || action === 'remove' || action === 'delete') {
    const r = memory.resolveMemory(args.name, list);
    if (r.error) return r;
    const denied = await confirm(context, `Forget memory "${r.memory.name}":\n${r.memory.text}`);
    if (denied) return denied;
    memory.removeMemory(r.memory.id, root);
    return { forgotten: true, name: r.memory.name };
  }

  return { error: `Unknown action "${args.action}". Use list, read, save or forget.` };
}

await refresh().catch(() => {});

export default {
  group: GROUP,
  label: 'Memories',
  description: 'Facts the assistant keeps across conversations. Nothing is saved unless you ask ("remember that…"), and every save or removal asks for your approval. While on, the saved memories are part of every request — with the Claude backend that means they are sent to Anthropic. Stored as plain files under data/memory/.',
  defaults: DEFAULTS,
  // Offered even while another plugin is in exclusive mode (Books' "Book only"), like `core`.
  alwaysOffered: true,
  beforeCard: refresh,

  configUi: () => ({
    fields: [
      {
        key: 'colorMatch', label: 'Only memories matching the chat color', type: 'boolean',
        note: 'A memory gets a color only when you ask for it ("remember this for this kind of chat"). While this is on, such a memory shows only in chats of its color; memories without a color show everywhere. Off: every memory shows in every chat.',
      },
      (() => {
        const fit = memory.fitIndex(memory.listMemories(), cache.cfg.indexMaxChars);
        return {
          key: 'indexMaxChars', label: 'List size (characters)', type: 'number',
          min: memory.MIN_INDEX_CHARS, max: memory.MAX_INDEX_CHARS_LIMIT, step: 1000, value: fit.cap,
          note: `How much of the assistant's instructions the memory list may take (about 4 characters per token). Now using ${fit.chars.toLocaleString('en-US')} of ${fit.cap.toLocaleString('en-US')}. When the list is full the newest memories are left out; the assistant can still look them up, but does not see them by itself.`,
        };
      })(),
    ],
    // Read-only list on the card: painted color swatch (N/A without one), name, text, date,
    // with a color filter. Removing or changing a memory is done by asking in chat.
    list: {
      title: 'Saved memories',
      emptyText: 'None yet. Ask in chat: "remember that…"',
      colorFilter: true,
      search: true,
      deletable: true, // ✕ per row → listDelete(id); the row's second click is the confirmation
      items: (() => {
        const all = memory.listMemories();
        const { listed } = memory.fitIndex(all, cache.cfg.indexMaxChars);
        return all.map((m, i) => ({
          id: m.id,
          title: m.name,
          text: m.text.replace(/\s+/g, ' ').slice(0, 600),
          color: m.color || null,
          meta: (m.updated || m.created || '').slice(0, 10),
          // Past the list size: saved, but not in the assistant's instructions.
          ...(i >= listed ? { flag: 'not listed', flagTip: 'Saved, but past the list size: the assistant does not see this memory unless it looks it up. Raise "List size" to include it.' } : {}),
        }));
      })(),
    },
  }),

  configChanged: async (current) => {
    current.indexMaxChars = memory.clampIndexChars(current.indexMaxChars);
    cache.cfg = { ...DEFAULTS, ...current };
    return {};
  },

  // The card's ✕ on a row. The user clicked it themselves (twice), so no chat approval prompt.
  listDelete: async (id) => {
    const found = memory.listMemories().find(m => m.id === id);
    if (!found) return { error: 'That memory no longer exists.' };
    memory.removeMemory(found.id);
    return { ok: true, message: `Forgot "${found.name}".` };
  },

  cardStatus: () => {
    const list = memory.listMemories();
    const tagged = list.filter(m => m.color).length;
    const remote = config.llm?.backend === 'claude' ? ' · sent to Anthropic with each request' : '';
    const base = `${list.length} ${list.length === 1 ? 'memory' : 'memories'}${tagged ? ` · ${tagged} with a color` : ''}${cache.cfg.colorMatch ? ' · color match on' : ''}${remote}`;
    // Counted over every memory, i.e. what a chat sees with color match off (the fullest case).
    const fit = memory.fitIndex(list, cache.cfg.indexMaxChars);
    if (fit.hidden > 0) {
      return { ok: false, text: `${base} · the newest ${fit.hidden} ${fit.hidden === 1 ? 'does' : 'do'} not fit in the list the assistant sees (${fit.cap.toLocaleString('en-US')} characters) — raise "List size" or shorten some` };
    }
    return { ok: true, text: base };
  },

  // Rendered last in the system prompt; `session` is the chat's color (null when unknown).
  promptTail: ({ session } = {}) =>
    memory.renderMemorySection(memory.listMemories(), { session, colorMatch: !!cache.cfg.colorMatch, maxChars: cache.cfg.indexMaxChars }),

  tools: {
    memory: {
      description: 'The user\'s saved memories (listed under "Memories" at the end of these instructions). Actions: list, read (full text of one), save (new, or replace the one with the same name), forget. save and forget ask the user for approval — call them only when the user asked to remember or forget something.',
      parameters: {
        action: 'string (list | read | save | forget)',
        name: 'string (read/save/forget: the memory\'s short name, e.g. "Home city")',
        text: 'string (save: the fact, written so it makes sense on its own)',
        description: 'string (save, optional: one line saying what a long memory is about)',
        color: 'string (save, optional: "current" ONLY when the user asks to keep it to this kind of chat; "none" removes the color)',
      },
      execute: (args, context) => runMemoryTool(args, context),
    },
  },
};
