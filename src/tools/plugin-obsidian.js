// Obsidian export plugin — see docs/OBSIDIAN.md.
//
// Manual, one-way export: the sidebar "Save to Obsidian" button (POST /:id/obsidian) and the
// `obsidian_export` tool write a note; nothing syncs by itself, and nothing in the vault points
// back. The plugin otherwise exists for the Plugins card (vault / folder / toggles) and its
// status line.
//
// When no vault resolves (Obsidian not installed and OBSIDIAN_VAULT unset) the route and the
// tool return a clear error; nothing is written anywhere.

import { readPluginConfig } from './index.js';
import conversations from '../services/conversations.js';
import obsidian from '../services/obsidian.js';
import config from '../config.js';

const GROUP = 'obsidian';
const DEFAULTS = {
  enabled: false,
  vault: '',              // '' = pick from Obsidian's registry (open vault, else most recent)
  folder: 'Lumispec',     // folder inside the vault that holds the notes
  includeTools: true,     // tool calls as folded callouts
  includeReasoning: false, // thinking traces — long, rarely worth keeping
};
const NO_VAULT = 'no vault configured — set OBSIDIAN_VAULT or pick a vault on the Obsidian plugin card';

async function getCfg() {
  const cfg = await readPluginConfig();
  return { ...DEFAULTS, ...(cfg[GROUP] || {}) };
}

/** Export one conversation now. Throws Error('no vault configured') when nothing resolves. */
export async function exportNow(convOrId) {
  const conv = typeof convOrId === 'string' ? conversations.get(convOrId) : convOrId;
  if (!conv) throw new Error('conversation not found');
  const cfg = await getCfg();
  const vault = obsidian.resolveVault(cfg);
  if (!vault) throw new Error('no vault configured');
  const model = await obsidian.getModelName();
  const result = obsidian.exportConversation(conv, cfg, { vault, model });
  console.log(`[obsidian] exported "${conv.title}" → ${result.path}${result.moved ? ` (moved from ${result.moved})` : ''}`);
  return result;
}

// ── Card ────────────────────────────────────────────

function statusLine() {
  const v = obsidian.resolveVault(cachedCfg || {});
  if (!v) {
    const installs = obsidian.findVaults();
    if (installs.length) return { ok: false, text: `Vault folder missing (${installs[0].path}) — pick another or set OBSIDIAN_VAULT` };
    return { ok: false, text: 'No vault found — Obsidian is not installed or has never opened a vault. Set OBSIDIAN_VAULT in .env to export into any folder' };
  }
  const via = { env: 'OBSIDIAN_VAULT', card: 'selected on this card', 'registry-open': 'open in Obsidian', 'registry-recent': 'most recent vault' }[v.source];
  return { ok: true, text: `Vault: ${v.path} (${via}) → ${(cachedCfg?.folder || DEFAULTS.folder)}/` };
}

// cardStatus()/configUi() are synchronous while the saved config is async; keep a copy that
// listPluginGroups() refreshes just before rendering (see refreshCachedConfig below).
let cachedCfg = null;
async function refreshCachedConfig() { cachedCfg = await getCfg(); }

export default {
  group: GROUP,
  label: 'Obsidian Export',
  description: 'Save to Obsidian: writes a conversation into your vault as a Markdown note with properties, folded tool calls and attachments.',
  defaults: DEFAULTS,
  // Generic field descriptors rendered by the Plugins panel (select / text / boolean).
  configUi: () => {
    const vaults = obsidian.findVaults();
    const env = config.obsidian?.vault || '';
    return {
      fields: [
        {
          key: 'vault', label: 'Vault', type: 'select',
          options: [
            { value: '', label: vaults.length ? `Auto (${vaults[0].path})` : 'Auto (none found)' },
            ...vaults.map(v => ({ value: v.path, label: `${v.path}${v.open ? ' (open)' : ''}` })),
          ],
          disabled: !!env,
          note: env ? `Overridden by OBSIDIAN_VAULT=${env}` : (vaults.length ? '' : 'No vaults in Obsidian’s registry'),
        },
        { key: 'folder', label: 'Folder in vault', type: 'text', placeholder: DEFAULTS.folder },
        { key: 'includeTools', label: 'Include tool results (folded)', type: 'boolean' },
        { key: 'includeReasoning', label: 'Include reasoning', type: 'boolean' },
      ],
    };
  },
  // listPluginGroups() calls this (when present) before cardStatus/configUi so they see fresh config.
  beforeCard: refreshCachedConfig,
  cardStatus: statusLine,
  enableWarning: () => (obsidian.resolveVault(cachedCfg || {})
    ? null
    : 'Obsidian Export is on, but no vault was found. Install Obsidian and open a vault, or set OBSIDIAN_VAULT in .env. Nothing is written until then.'),
  prompt: `## Obsidian
- The user can ask to save the current conversation to their Obsidian vault; call "obsidian_export" with no arguments. Do not call it unless asked.`,
  tools: {
    obsidian_export: {
      description: 'Export the current conversation to the user\'s Obsidian vault as a Markdown note. No parameters. Only when the user asks.',
      parameters: {},
      execute: async (_args, context) => {
        try {
          const r = await exportNow(context?.conversationId);
          return { ok: true, path: r.path, attachments: r.attachments.length };
        } catch (e) {
          return { error: e.message === 'no vault configured' ? NO_VAULT : e.message };
        }
      },
    },
  },
};
