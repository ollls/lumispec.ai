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

/**
 * Build a progress handler that logs every step the extension reports and streams
 * a short status line to the frontend. Used to give visibility into per-step planner
 * activity inside a single page_action call (otherwise invisible from tool logs).
 * @param {string} toolName
 * @param {object} context
 */
function makeProgressHandler(toolName, context) {
  let stepCounter = 0;
  return (msg) => {
    stepCounter += 1;
    // Full message goes to the log file for post-mortem analysis
    logToolCall(toolName, 'step', { n: stepCounter, ...msg });
    // Short human-readable line for the frontend tool_status stream
    if (context?.sendStatus) {
      const label = msg.action || msg.type || 'step';
      const detail = msg.url || msg.title || msg.message || msg.data || '';
      const snippet = typeof detail === 'string' ? detail.slice(0, 120) : '';
      context.sendStatus(`[page agent ${stepCounter}] ${label}${snippet ? ' — ' + snippet : ''}`);
    }
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
  label: 'Alibaba Page Agent',
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
    '- Browser interaction (click, type, fill, open tab, switch tab, scroll, extract) → use page_tabs first, then page_action',
  ],
  prompt: `## Browser Control (Page Agent)
- Use page_tabs first to see which browser tabs are available before acting.
- page_action takes a single parameter: \`task\` (a plain-English string). That is the ONLY parameter. Do not invent other parameter names like "action", "url", or "type" — they will be rejected.
- Describe the goal in natural language. The extension has its own planner that figures out clicks, scrolls, tab switches, and URL loading internally — you never name those primitives.
- Reference target tabs by title or URL inside the task string, e.g. \`task: "On the Gmail tab, click Compose"\`.
- To load a URL, just say so: \`task: "Open amazon.com in a new tab"\`. Do not say "navigate to".
- The extension has an internal per-call step budget. To stay under it, split work along this rule:
  - **Bundle** small actions that happen on the same page: filling a form and submitting, clicking through a menu, scrolling and reading. One \`page_action\` call.
  - **Split** when the task crosses pages or loads new content: do navigation in one \`page_action\` call, then extraction in a second call. The step budget resets between calls.
- Example of the split rule: first \`task: "Open amazon.com and go to Your Orders"\`, then \`task: "On the current Your Orders page, return the first 10 orders with date, item, and total"\`. Do NOT try to do both in one call — navigation eats the step budget before extraction starts.
- For list/table extraction, ask for everything in one shot inside the extraction call (not row by row).
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
            { ...llmConfig(), experimentalIncludeAllTabs: true },
            makeProgressHandler('page_tabs', context)
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
          const result = await hub.executeTask(
            task,
            { ...llmConfig(), experimentalIncludeAllTabs: true },
            makeProgressHandler('page_action', context)
          );
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
