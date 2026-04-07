import config from '../../config.js';
import { HubBridge } from './hub-bridge.js';
import { logToolCall, readPluginConfig } from '../index.js';

let hub = null;

const DEFAULTS = { delayEnabled: false, delaySeconds: 5 };

async function getDelayConfig() {
  const cfg = await readPluginConfig();
  const entry = cfg.pageagent || {};
  return {
    delayEnabled: entry.delayEnabled ?? DEFAULTS.delayEnabled,
    delaySeconds: Number(entry.delaySeconds ?? DEFAULTS.delaySeconds),
  };
}

async function applyActivationDelay(context) {
  // Only delay on the first Page Agent call within a single user-prompt turn
  if (context?.turnState?.pageagentDelayApplied) return;
  const { delayEnabled, delaySeconds } = await getDelayConfig();
  if (context?.turnState) context.turnState.pageagentDelayApplied = true;
  if (!delayEnabled || !delaySeconds || delaySeconds <= 0) return;
  if (context?.sendStatus) {
    context.sendStatus(`⏳ Delay enabled (${delaySeconds}s) — if you want Page Agent to work with an existing browser tab, switch to it now.`);
  }
  await new Promise(r => setTimeout(r, delaySeconds * 1000));
}

async function startBridge() {
  if (hub) return;
  const bridge = new HubBridge(config.pageagent.port);
  try {
    await bridge.start();
    hub = bridge;
  } catch (err) {
    console.error(`[pageagent] Failed to start bridge: ${err.message}`);
  }
}

async function stopBridge() {
  if (!hub) return;
  await hub.stop();
  hub = null;
}

// Ensure port is freed on process exit
process.on('exit', () => { if (hub) { try { hub.stopTask(); } catch {} } });
process.on('SIGTERM', () => { stopBridge().then(() => process.exit(0)); });
process.on('SIGINT', () => { stopBridge().then(() => process.exit(0)); });

function llmConfig() {
  if (config.llm.backend === 'claude') {
    return { baseURL: 'https://api.anthropic.com', model: config.claude.model, apiKey: config.claude.apiKey };
  }
  return { baseURL: config.llama.baseUrl };
}

export default {
  group: 'pageagent',
  label: 'Page Agent',
  description: 'Browser automation via Page Agent Chrome extension.',
  hint: 'Use words like "open", "log in", "click", "type", "fill", or "navigate" to route to Page Agent. After connecting, enable "Auto-approve connections" in the Page Agent hub tab (pinned tab) — required for tasks to work.',
  defaultEnabled: false,
  defaults: { enabled: false, ...DEFAULTS },
  requiresBrowser: 'chrome',
  condition: () => hub?.connected ?? false,
  onEnable: startBridge,
  onDisable: stopBridge,
  status: {
    label: 'Page Agent',
    interval: 5000,
    clickUrl: `http://localhost:${config.pageagent.port}`,
    poll: async () => !hub ? null : hub.connected ? 'ok' : 'unauth',
  },
  routing: [
    '- Browser interaction (click, type, fill, navigate, extract) → use page_tabs first, then page_action',
  ],
  prompt: `## Browser Control (Page Agent)
- Use page_tabs first to see which browser tabs are available before acting.
- page_action sends a natural language task to the Chrome extension. It can see and switch between all open tabs.
- Reference the target tab by title or URL in your task, e.g. "On the Gmail tab, click Compose".
- Describe WHAT to do, not HOW. The extension figures out DOM actions.
- If Page Agent is not connected, tell the user to click the amber Page Agent indicator in the status bar.`,
  tools: {
    page_tabs: {
      description: 'List open browser tabs the agent can see. Call before page_action to identify the right tab.',
      parameters: {},
      execute: async (_params, context) => {
        if (!hub) return { error: 'Page Agent not running. Enable it in Plugins.' };
        if (!hub.connected) return { error: 'Extension not connected. Click Page Agent in status bar.' };
        if (hub.busy) return { error: 'Already running a task.' };
        try {
          await applyActivationDelay(context);
          const result = await hub.executeTask(
            'List all open tabs. For each tab report: tab title, URL. Do NOT click anything or navigate. Just report what tabs are open.',
            { ...llmConfig(), experimentalIncludeAllTabs: true }
          );
          logToolCall('page_tabs', 'list', { success: result.success });
          return result;
        } catch (err) {
          logToolCall('page_tabs', 'error', { error: err.message });
          return { error: err.message };
        }
      },
    },
    page_action: {
      description: 'Execute a browser task via Page Agent Chrome extension. Can see and switch between all open tabs.',
      parameters: { task: 'string (natural language instruction for the browser)' },
      execute: async ({ task }, context) => {
        if (!hub) return { error: 'Page Agent not running. Enable it in Plugins.' };
        if (!hub.connected) return { error: 'Extension not connected. Click Page Agent in status bar.' };
        if (hub.busy) return { error: 'Already running a task.' };
        try {
          await applyActivationDelay(context);
          const result = await hub.executeTask(task, { ...llmConfig(), experimentalIncludeAllTabs: true });
          logToolCall('page_action', 'execute', { task, success: result.success });
          return result;
        } catch (err) {
          logToolCall('page_action', 'error', { task, error: err.message });
          return { error: err.message };
        }
      },
    },
  },
};
