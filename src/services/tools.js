// Tool registry — single source of truth
const tools = {
  current_datetime: {
    description: 'Returns the current date and time in UTC and local time with timezone. Takes no arguments.',
    parameters: {},
    execute: () => {
      const now = new Date();
      return {
        utc: now.toISOString(),
        local: now.toString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offset: now.getTimezoneOffset(),
      };
    },
  },
};

// Build system prompt from registry
export function getSystemPrompt() {
  const toolList = Object.entries(tools)
    .map(([name, t]) => `- ${name}: ${t.description}`)
    .join('\n');

  return `You have access to tools. To use a tool, respond ONLY with:

<tool_call>
{"name": "tool_name", "arguments": {}}
</tool_call>

Available tools:
${toolList}

Rules:
- Output ONLY the <tool_call> block when using a tool, no other text.
- Wait for the tool result before answering.
- Do not fabricate tool results.`;
}

// Parse <tool_call>...</tool_call> from LLM output
export function parseToolCall(text) {
  const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    return { name: parsed.name, arguments: parsed.arguments || {} };
  } catch {
    return null;
  }
}

// Execute a tool by name
export function executeTool(name, args) {
  const tool = tools[name];
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  try {
    return JSON.stringify(tool.execute(args));
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
