// Backward-compatibility barrel — re-exports from the new plugin system
export {
  loadPlugins,
  listTools,
  setToolEnabled,
  getSystemPrompt,
  parseToolCalls,
  executeTool,
  requestConfirmation,
  resolveConfirmation,
  cancelConfirmation,
  isToolGroupEnabled,
} from '../tools/index.js';
