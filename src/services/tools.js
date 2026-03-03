import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

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
  web_search: {
    description: 'Search the web using DuckDuckGo. Requires a "query" argument.',
    parameters: { query: 'string' },
    execute: async ({ query }) => {
      // Connection: close prevents keep-alive pooling.
      // DDG detects repeated requests on persistent connections and triggers CAPTCHA blocks.
      const res = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
          'Connection': 'close',
        },
        body: new URLSearchParams({ q: query }),
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();
      const { document } = parseHTML(html);
      const links = document.querySelectorAll('a.result-link');
      const snippets = document.querySelectorAll('.result-snippet');
      const results = [];
      for (let i = 0; i < Math.min(links.length, 5); i++) {
        results.push({
          title: links[i]?.textContent?.trim(),
          url: links[i]?.getAttribute('href'),
          description: snippets[i]?.textContent?.trim() || '',
        });
      }
      return { results };
    },
  },
  web_fetch: {
    description: 'Fetch a web page and extract its content as markdown. Requires a "url" argument. Use after web_search to read a specific page.',
    parameters: { url: 'string' },
    execute: async ({ url }) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LLM-Workbench/1.0)' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      const html = await res.text();
      const { document } = parseHTML(html);

      const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
      turndown.remove(['script', 'style', 'noscript']);

      // Try Readability (article extraction)
      const article = new Readability(document).parse();

      let markdown, title;
      if (article && article.content) {
        markdown = turndown.turndown(article.content);
        title = article.title;
      } else {
        // Fallback: strip boilerplate from raw HTML
        const { document: doc2 } = parseHTML(html);
        for (const sel of ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'aside']) {
          doc2.querySelectorAll(sel).forEach(el => el.remove());
        }
        markdown = turndown.turndown(doc2.toString());
        title = doc2.querySelector('title')?.textContent || '';
      }

      // Truncate to keep token usage reasonable
      const maxLen = 4000;
      if (markdown.length > maxLen) {
        markdown = markdown.slice(0, maxLen) + '\n\n[...truncated]';
      }

      return { url, title, content: markdown };
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
export async function executeTool(name, args) {
  const tool = tools[name];
  if (!tool) return JSON.stringify({ error: `Unknown tool: ${name}` });
  try {
    const result = await tool.execute(args);
    return JSON.stringify(result);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}
