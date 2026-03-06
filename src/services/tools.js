import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import config from '../config.js';

// ── Search engine backends ───────────────────────────
async function searchTavily(query) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.tavily.apiKey}`,
    },
    body: JSON.stringify({ query, max_results: 5 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[web_search] Tavily returned ${res.status}: ${body}`);
    return { error: `Search failed (HTTP ${res.status})`, results: [] };
  }
  const data = await res.json();
  return { results: (data.results || []).map(r => ({ title: r.title, url: r.url, description: r.content || '' })) };
}

async function searchKeiro(query) {
  const res = await fetch(`${config.keiro.baseUrl}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: config.keiro.apiKey, query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn(`[web_search] Keiro returned ${res.status}: ${body}`);
    return { error: `Search failed (HTTP ${res.status})`, results: [] };
  }
  const data = await res.json();
  const results = data.data?.search_results || [];
  return { results: results.slice(0, 5).map(r => ({ title: r.title || '', url: r.url || '', description: r.snippet || '' })) };
}

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
    description: 'Search the web. Requires a "query" argument.',
    parameters: { query: 'string' },
    execute: async ({ query }) => {
      const engine = config.search.engine;
      if (engine === 'tavily') {
        const res = await searchTavily(query);
        return { ...res, sources: 'Tavily' };
      }
      if (engine === 'keiro') {
        const res = await searchKeiro(query);
        return { ...res, sources: 'Keiro' };
      }
      // 'both' — run in parallel, merge and deduplicate by URL
      const [keiro, tavily] = await Promise.all([
        searchKeiro(query).catch(e => ({ error: e.message, results: [] })),
        searchTavily(query).catch(e => ({ error: e.message, results: [] })),
      ]);
      const keiroOk = keiro.results.length > 0;
      const tavilyOk = tavily.results.length > 0;
      let sources;
      if (keiroOk && tavilyOk) sources = 'Keiro + Tavily';
      else if (keiroOk) sources = 'Keiro (Tavily failed)';
      else if (tavilyOk) sources = 'Tavily (Keiro failed)';
      else sources = 'both failed';
      const seen = new Set();
      const merged = [];
      for (const r of [...keiro.results, ...tavily.results]) {
        if (!seen.has(r.url)) {
          seen.add(r.url);
          merged.push(r);
        }
      }
      return { results: merged.slice(0, 8), sources };
    },
  },
  web_fetch: {
    description: 'Fetch a web page and extract its full content as markdown. Requires a "url" argument. ALWAYS use after web_search to read the most relevant result before answering.',
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

  const now = new Date();
  const datetime = {
    utc: now.toISOString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offset: now.getTimezoneOffset(),
  };

  return `You are a helpful, knowledgeable assistant. Current date/time: ${datetime.local} (UTC: ${datetime.utc}, timezone: ${datetime.timezone}). Your training data may be outdated — for questions about current events, people in office, recent news, or anything time-sensitive, ALWAYS use web_search first before answering.

To use a tool, respond ONLY with:

<tool_call>
{"name": "tool_name", "arguments": {}}
</tool_call>

Available tools:
${toolList}

Tool rules:
- Output ONLY the <tool_call> block when using a tool, no other text.
- Wait for the tool result before answering.
- Do not fabricate tool results.
- After web_search, ALWAYS use web_fetch on the most relevant result URL to get full details before answering. Search snippets alone are not sufficient.

## Response Formatting

Adapt formatting to response length:
- **Under 50 words**: Plain text, no special formatting needed.
- **50–150 words**: Use **bold** for key terms. Keep to 1–2 short paragraphs.
- **150–300 words**: Use ## headers to break into sections. Use bullet points where appropriate.
- **Over 300 words**: Begin with a **Key Takeaway** block (2–3 bullets). Use headers, lists, and tables.

Rules:
- Answer the question in the first sentence. Never bury the conclusion.
- Use **bold** for key terms only — never bold entire sentences.
- Use bullet points for 3+ related items. Use numbered lists only for sequential steps.
- Use tables for comparisons of 3+ items.
- Use fenced code blocks with language tags for code. Use \`inline code\` for technical terms.
- Keep paragraphs to 2–4 sentences.
- Use emoji sparingly as section markers (e.g., 📌 Key Point, ⚠️ Warning) — never inline or decorative.
- Use plain, direct language. No filler phrases or sycophantic openers.
- Separate major topic shifts with a horizontal rule (---).`;
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
