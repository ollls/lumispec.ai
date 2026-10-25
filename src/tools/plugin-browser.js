// Browser Search — routes web_search / web_fetch through the Lumispec Browser Search
// Chrome extension (extension/), which runs the query in a hidden tab of the user's own
// browser. While this plugin is enabled it SUPERSEDES the "web" plugin: the regular
// Web Search & Fetch group is hot-unloaded and its slider is grayed out, so every
// web_search / web_fetch call lands here. Disabling it restores "web" to its saved state.
//
// Status: part 2 of 3. The extension (part 1) is done; the WebSocket bridge to it is
// part 3. Until then both tools are stubs that explain the situation to the LLM.

const NOT_READY =
  'Browser Search is enabled but the browser bridge is not implemented yet (coming in part 3). ' +
  'Tell the user to disable the "Browser Search" plugin in the Plugins panel to use the regular Web Search & Fetch.';

export default {
  group: 'browser',
  label: 'Browser Search',
  description: 'Runs web_search and web_fetch in a hidden tab of your own Chrome via the Lumispec Browser Search extension. Replaces Web Search & Fetch while enabled.',
  supersedes: ['web'],
  defaults: { enabled: false },
  status: {
    label: 'Browser',
    interval: 5000,
    // Part 3 wires this to the WebSocket bridge: 'ok' when the extension is connected.
    poll: async () => 'unauth',
  },
  routing: [
    '- Web questions, current events, news → use "web_search" then "web_fetch"',
  ],
  prompt: `## Web Research (via browser extension)
- web_search and web_fetch run inside the user's own browser. If a tool reports the browser is not connected or not implemented, say so plainly and do not retry.
- Write web_search queries as plain keywords. \`site:\` is fine.
- Maximum 3 web_search calls and 3 web_fetch calls per user question.`,
  tools: {
    web_search: {
      description: 'Search the web through the user\'s browser. Requires a "query" argument.',
      parameters: { query: 'string' },
      execute: async () => ({ error: NOT_READY, results: [] }),
    },
    web_fetch: {
      description: 'Fetch a URL through the user\'s browser and return its content as markdown. Requires a "url" argument.',
      parameters: { url: 'string' },
      execute: async () => ({ error: NOT_READY }),
    },
  },
};
