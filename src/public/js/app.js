// ── State ──────────────────────────────────────────────
const state = {
  currentConversationId: null,
  conversations: [],
  abortController: null,
  healthy: false,
  maxContext: 131072,
  pendingImages: [], // { dataUrl, mimeType, name }
};

// ── DOM refs ──────────────────────────────────────────
const sidebar = document.getElementById('conversation-list');
const newChatBtn = document.getElementById('new-chat-btn');
const responseArea = document.getElementById('response-area');
const emptyState = document.getElementById('empty-state');
const form = document.getElementById('prompt-form');
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const healthDot = document.getElementById('health-dot');
const healthLabel = document.getElementById('health-label');
const slotsToggle = document.getElementById('slots-toggle');
const slotsSummary = document.getElementById('slots-summary');
const slotPanel = document.getElementById('slot-panel');
const slotCards = document.getElementById('slot-cards');
const contextBar = document.getElementById('context-bar');
const contextLabel = document.getElementById('context-label');
const inetDot = document.getElementById('inet-dot');
const inetLabel = document.getElementById('inet-label');
const searchDot = document.getElementById('search-dot');
const searchLabel = document.getElementById('search-label');
const searchToggle = document.getElementById('search-toggle');
const searchDropdown = document.getElementById('search-dropdown');
const toolUsageToggle = document.getElementById('tool-usage-toggle');
const toolUsageCount = document.getElementById('tool-usage-count');
const toolUsageDropdown = document.getElementById('tool-usage-dropdown');
const etradeStatus = document.getElementById('etrade-status');
const etradeDot = document.getElementById('etrade-dot');
const etradeToggle = document.getElementById('etrade-toggle');
const etradePanel = document.getElementById('etrade-panel');
const etradePanelContent = document.getElementById('etrade-panel-content');
const imageInput = document.getElementById('image-input');
const attachBtn = document.getElementById('attach-btn');
const imagePreviewStrip = document.getElementById('image-preview-strip');
const savePromptBtn = document.getElementById('save-prompt-btn');
const clearPromptBtn = document.getElementById('clear-prompt-btn');
const promptList = document.getElementById('prompt-list');
const promptsToggle = document.getElementById('prompts-toggle');
const promptsDropdown = document.getElementById('prompts-dropdown');
const toolsToggle = document.getElementById('tools-toggle');
const toolsDropdown = document.getElementById('tools-dropdown');
const toolsList = document.getElementById('tools-list');

// ── API layer ─────────────────────────────────────────
const api = {
  async listConversations() {
    const res = await fetch('/api/conversations');
    return res.json();
  },
  async createConversation(title) {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return res.json();
  },
  async getConversation(id) {
    const res = await fetch(`/api/conversations/${id}`);
    return res.json();
  },
  async deleteConversation(id) {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  },
  async updateTitle(id, title) {
    const res = await fetch(`/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return res.json();
  },
  async checkHealth() {
    const res = await fetch('/api/health');
    return { ok: res.ok, data: await res.json() };
  },
  async fetchSlots() {
    const res = await fetch('/api/slots');
    return res.json();
  },
  async pinSlot(conversationId, slotId) {
    await fetch('/api/slots/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId, slotId }),
    });
  },
  async unpinSlot(conversationId) {
    await fetch('/api/slots/unpin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
  },
};

// ── Sidebar ───────────────────────────────────────────
async function refreshSidebar() {
  state.conversations = await api.listConversations();
  renderSidebar();
}

function renderSidebar() {
  sidebar.innerHTML = '';
  for (const conv of state.conversations) {
    const item = document.createElement('div');
    const isActive = conv.id === state.currentConversationId;
    item.className = `group flex items-center gap-2 px-4 py-3 cursor-pointer border-b border-zinc-800/50 transition-colors ${
      isActive ? 'bg-zinc-800/70' : 'hover:bg-zinc-900'
    }`;

    const title = document.createElement('span');
    title.className = 'flex-1 text-sm truncate ' + (isActive ? 'text-zinc-100' : 'text-zinc-400');
    title.textContent = conv.title;

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '✕';
    let confirmTimeout = null;
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (delBtn.dataset.confirm) {
        clearTimeout(confirmTimeout);
        deleteConversation(conv.id);
      } else {
        delBtn.dataset.confirm = '1';
        delBtn.textContent = 'Delete?';
        delBtn.className = 'text-red-400 text-xs px-2 py-0.5 rounded bg-red-400/10 shrink-0 font-medium';
        confirmTimeout = setTimeout(() => {
          delete delBtn.dataset.confirm;
          delBtn.textContent = '✕';
          delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
        }, 3000);
      }
    });

    item.addEventListener('click', () => switchConversation(conv.id));
    item.appendChild(title);
    item.appendChild(delBtn);
    sidebar.appendChild(item);
  }
}

async function switchConversation(id) {
  if (id === state.currentConversationId) return;
  // Abort any in-flight stream
  if (state.abortController) state.abortController.abort();

  state.currentConversationId = id;
  renderSidebar();

  const conv = await api.getConversation(id);
  renderMessages(conv.messages);
  updateContextBar(conv.tokenCount);
}

async function deleteConversation(id) {
  await api.deleteConversation(id);
  if (state.currentConversationId === id) {
    state.currentConversationId = null;
    showEmptyState();
  }
  refreshSidebar();
}

function showEmptyState() {
  responseArea.innerHTML = '';
  responseArea.appendChild(emptyState);
  emptyState.classList.remove('hidden');
  updateContextBar(0);
}

// ── Markdown rendering ───────────────────────────────
marked.setOptions({
  highlight: (code, lang) => {
    if (lang === 'mermaid') return code; // don't highlight mermaid, render later
    if (typeof hljs === 'undefined') return code;
    if (lang && hljs.getLanguage(lang)) {
      try { return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value; } catch {}
    }
    try { return hljs.highlightAuto(code).value; } catch {}
    return code;
  },
  breaks: true,
  gfm: true,
});

// Initialize Mermaid with dark theme
if (typeof mermaid !== 'undefined') {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      darkMode: true,
      background: '#18181b',
      primaryColor: '#6366f1',
      primaryTextColor: '#e4e4e7',
      lineColor: '#71717a',
    },
  });
}

let _mermaidId = 0;

function renderFormattedContent(text, container, { renderMermaid = false } = {}) {
  const raw = marked.parse(text);
  container.innerHTML = DOMPurify.sanitize(raw);
  container.classList.add('markdown-body');

  if (renderMermaid && typeof mermaid !== 'undefined') {
    container.querySelectorAll('code.language-mermaid').forEach(async (codeEl) => {
      const pre = codeEl.parentElement;
      const source = codeEl.textContent;
      const id = `mermaid-${++_mermaidId}`;
      try {
        const { svg } = await mermaid.render(id, source);
        const div = document.createElement('div');
        div.className = 'mermaid-chart';
        div.innerHTML = svg;
        pre.replaceWith(div);
      } catch {
        // leave as code block if mermaid fails to parse
      }
    });
  }
}

let _renderTimer = null;
let _lastRenderTime = 0;
const RENDER_INTERVAL = 80;

function scheduleRender(text, container) {
  const now = Date.now();
  if (now - _lastRenderTime >= RENDER_INTERVAL) {
    _lastRenderTime = now;
    renderFormattedContent(text, container);
    return;
  }
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(() => {
    _lastRenderTime = Date.now();
    renderFormattedContent(text, container);
  }, RENDER_INTERVAL - (now - _lastRenderTime));
}

// ── File download link helper ─────────────────────────
function makeFileDownloadLink(toolName, resultStr) {
  try {
    const parsed = JSON.parse(resultStr);
    // Direct save_file result or nested savedFile from other tools (e.g. etrade_account)
    const fileInfo = toolName === 'save_file' ? parsed : parsed.savedFile;
    if (!fileInfo?.url || !fileInfo?.filename) return null;
    const sizeStr = fileInfo.size >= 1024 ? `${(fileInfo.size / 1024).toFixed(1)} KB` : `${fileInfo.size} bytes`;
    const link = document.createElement('a');
    link.href = fileInfo.url;
    link.download = fileInfo.filename;
    link.className = 'inline-flex items-center gap-1 mt-1 px-2 py-1 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded transition-colors';
    link.innerHTML = `<span>📥</span> Download <strong>${fileInfo.filename}</strong> <span class="text-zinc-400">(${sizeStr})</span>`;
    return link;
  } catch { return null; }
}

// ── Messages ──────────────────────────────────────────
function renderMessages(messages) {
  responseArea.innerHTML = '';
  emptyState.classList.add('hidden');
  for (const msg of messages) {
    const text = typeof msg.content === 'object' ? msg.content.text : msg.content;
    const images = typeof msg.content === 'object' ? msg.content.images : undefined;
    const reasoning = typeof msg.content === 'object' ? msg.content.reasoning : undefined;
    const toolUses = typeof msg.content === 'object' ? msg.content.toolUses : undefined;
    appendMessage(msg.role, text, images, { reasoning, toolUses });
  }
}

function appendMessage(role, text, images, meta = {}) {
  emptyState.classList.add('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'max-w-4xl mx-auto flex ' + (role === 'user' ? 'justify-end' : 'justify-start');

  const bubble = document.createElement('div');
  if (role === 'user') {
    bubble.className = 'max-w-[80%] bg-indigo-600/20 border border-indigo-500/30 text-zinc-100 rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap';
  } else if (role === 'error') {
    bubble.className = 'max-w-[80%] bg-red-600/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm leading-relaxed';
  } else {
    bubble.className = 'max-w-[80%] bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 rounded-xl px-4 py-3 text-sm leading-relaxed break-words';
  }

  // Render images in user bubbles
  if (role === 'user' && images && images.length > 0) {
    const imgGrid = document.createElement('div');
    imgGrid.className = 'msg-image-grid mb-2';
    for (const img of images) {
      const imgEl = document.createElement('img');
      imgEl.src = img.dataUrl || `data:${img.mimeType};base64,${img.base64}`;
      imgEl.className = 'msg-image-thumb';
      imgEl.addEventListener('click', () => {
        const overlay = document.createElement('div');
        overlay.className = 'image-overlay';
        const full = document.createElement('img');
        full.src = imgEl.src;
        full.className = 'image-overlay-img';
        overlay.appendChild(full);
        overlay.addEventListener('click', () => overlay.remove());
        document.body.appendChild(overlay);
      });
      imgGrid.appendChild(imgEl);
    }
    bubble.appendChild(imgGrid);
  }

  // Render stored reasoning block (collapsed)
  if (role === 'assistant' && meta.reasoning) {
    const details = document.createElement('details');
    details.className = 'mb-2 text-zinc-500 text-xs';
    const summary = document.createElement('summary');
    summary.className = 'cursor-pointer select-none text-zinc-500 hover:text-zinc-400';
    summary.textContent = 'Thought process';
    const body = document.createElement('pre');
    body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-60 overflow-y-auto slim-scrollbar';
    body.textContent = meta.reasoning;
    details.appendChild(summary);
    details.appendChild(body);
    bubble.appendChild(details);
  }

  // Render stored tool uses (collapsed)
  if (role === 'assistant' && meta.toolUses && meta.toolUses.length > 0) {
    const container = document.createElement('div');
    container.className = 'tool-use-container';
    for (const tu of meta.toolUses) {
      const detail = document.createElement('details');
      detail.className = 'mb-2 text-zinc-500 text-xs';
      const summary = document.createElement('summary');
      summary.className = 'cursor-pointer select-none text-zinc-500 hover:text-zinc-400';
      let sourcesTag = '';
      if (tu.name === 'web_search') {
        try {
          const parsed = JSON.parse(tu.result);
          if (parsed.sources) sourcesTag = ` <span class="text-zinc-600">— ${parsed.sources}</span>`;
        } catch {}
      }
      summary.innerHTML = `<span class="mr-1">🔧</span> Used <strong>${tu.name}</strong>${sourcesTag}`;
      const body = document.createElement('pre');
      body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-40 overflow-y-auto slim-scrollbar';
      body.textContent = tu.result;
      detail.appendChild(summary);
      detail.appendChild(body);
      container.appendChild(detail);
      const dl = makeFileDownloadLink(tu.name, tu.result);
      if (dl) container.appendChild(dl);
    }
    bubble.appendChild(container);
  }

  if (role === 'assistant' && text) {
    const contentSpan = document.createElement('span');
    renderFormattedContent(text, contentSpan, { renderMermaid: true });
    bubble.appendChild(contentSpan);
  } else if (text) {
    const textNode = document.createTextNode(text);
    bubble.appendChild(textNode);
  }
  wrapper.appendChild(bubble);
  responseArea.appendChild(wrapper);
  responseArea.scrollTop = responseArea.scrollHeight;
  return bubble;
}

// ── Streaming ─────────────────────────────────────────
async function sendMessage(content, images) {
  if (!state.currentConversationId) return;

  appendMessage('user', content, images);
  const bubble = appendMessage('assistant', '');
  sendBtn.disabled = true;

  // Create a collapsed reasoning block inside the bubble
  const reasoningDetails = document.createElement('details');
  reasoningDetails.className = 'mb-2 text-zinc-500 text-xs';
  const reasoningSummary = document.createElement('summary');
  reasoningSummary.className = 'cursor-pointer select-none text-zinc-500 hover:text-zinc-400';
  reasoningSummary.textContent = 'Thinking…';
  const reasoningBody = document.createElement('pre');
  reasoningBody.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-60 overflow-y-auto slim-scrollbar';
  reasoningDetails.appendChild(reasoningSummary);
  reasoningDetails.appendChild(reasoningBody);

  const contentSpan = document.createElement('span');
  bubble.textContent = '';
  bubble.appendChild(contentSpan);

  // Tool use indicator container (inserted before content)
  const toolUseContainer = document.createElement('div');
  toolUseContainer.className = 'tool-use-container';

  let hasReasoning = false;
  let hasToolUse = false;

  state.abortController = new AbortController();
  let accumulated = '';
  let accumulatedReasoning = '';
  _lastRenderTime = 0;
  clearTimeout(_renderTimer);

  try {
    const res = await fetch(`/api/conversations/${state.currentConversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        images: images ? images.map(i => ({ mimeType: i.mimeType, base64: i.base64 })) : undefined,
      }),
      signal: state.abortController.signal,
    });

    // Refresh slots shortly after backend assigns slot
    setTimeout(refreshSlots, 500);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;
          try {
            const data = JSON.parse(payload);
            if (data.reasoning) {
              if (!hasReasoning) {
                hasReasoning = true;
                bubble.insertBefore(reasoningDetails, contentSpan);
              }
              accumulatedReasoning += data.reasoning;
              reasoningBody.textContent = accumulatedReasoning;
              responseArea.scrollTop = responseArea.scrollHeight;
            }
            if (data.tool_use) {
              trackToolUse(data.tool_use.name);
              if (!hasToolUse) {
                hasToolUse = true;
                bubble.insertBefore(toolUseContainer, contentSpan);
              }
              const detail = document.createElement('details');
              detail.className = 'mb-2 text-zinc-500 text-xs';
              const summary = document.createElement('summary');
              summary.className = 'cursor-pointer select-none text-zinc-500 hover:text-zinc-400';
              let sourcesTag = '';
              if (data.tool_use.name === 'web_search') {
                try {
                  const parsed = JSON.parse(data.tool_use.result);
                  if (parsed.sources) sourcesTag = ` <span class="text-zinc-600">— ${parsed.sources}</span>`;
                } catch {}
                pollSearch();
              }
              summary.innerHTML = `<span class="mr-1">🔧</span> Used <strong>${data.tool_use.name}</strong>${sourcesTag}`;
              const body = document.createElement('pre');
              body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-40 overflow-y-auto slim-scrollbar';
              body.textContent = data.tool_use.result;
              detail.appendChild(summary);
              detail.appendChild(body);
              toolUseContainer.appendChild(detail);
              const dl = makeFileDownloadLink(data.tool_use.name, data.tool_use.result);
              if (dl) toolUseContainer.appendChild(dl);
              responseArea.scrollTop = responseArea.scrollHeight;
            }
            if (data.content) {
              if (hasReasoning) reasoningSummary.textContent = 'Thought process';
              accumulated += data.content;
              scheduleRender(accumulated, contentSpan);
              responseArea.scrollTop = responseArea.scrollHeight;
            }
            if (data.usage) {
              const total = data.usage.total_tokens || data.usage.prompt_tokens + data.usage.completion_tokens || 0;
              updateContextBar(total);
            }
            if (data.error) {
              bubble.textContent = `[Error: ${data.error}]`;
              bubble.className = 'max-w-[80%] bg-red-600/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm leading-relaxed';
            }
          } catch { /* skip malformed */ }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      bubble.textContent = `[Error: ${err.message}]`;
      bubble.className = 'max-w-[80%] bg-red-600/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm leading-relaxed';
    }
  } finally {
    clearTimeout(_renderTimer);
    if (accumulated) renderFormattedContent(accumulated, contentSpan, { renderMermaid: true });
    state.abortController = null;
    sendBtn.disabled = false;
    input.focus();
    // Refresh sidebar to pick up auto-title, slots to clear active state
    refreshSidebar();
    refreshSlots();
  }
}

// ── Context bar ───────────────────────────────────────
function updateContextBar(tokens) {
  state.lastTokenCount = tokens;
  const pct = Math.min(100, (tokens / state.maxContext) * 100);
  contextBar.style.width = pct + '%';

  // Format token count
  const fmt = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'K' : String(tokens);
  const max = (state.maxContext / 1000).toFixed(0) + 'K';
  contextLabel.textContent = `${fmt} / ${max}`;

  // Color shift
  contextBar.classList.remove('bg-indigo-500', 'bg-amber-500', 'bg-red-500');
  if (pct > 90) contextBar.classList.add('bg-red-500');
  else if (pct > 75) contextBar.classList.add('bg-amber-500');
  else contextBar.classList.add('bg-indigo-500');
}

// ── Health polling ────────────────────────────────────
async function pollHealth() {
  try {
    const { ok, data } = await api.checkHealth();
    state.healthy = ok;
    healthDot.className = `inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500 pulse-dot' : 'bg-red-500'}`;
    healthLabel.textContent = ok ? 'llama.cpp' : 'llama.cpp';
    healthLabel.className = ok ? 'text-green-500' : 'text-red-400';
  } catch {
    state.healthy = false;
    healthDot.className = 'inline-block w-2 h-2 rounded-full bg-red-500';
    healthLabel.textContent = 'llama.cpp';
    healthLabel.className = 'text-red-400';
  }
}

// ── Internet check ────────────────────────────────────
async function pollInternet() {
  try {
    const res = await fetch('/api/health/internet');
    const { ok } = await res.json();
    inetDot.className = `inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500 pulse-dot' : 'bg-red-500'}`;
    inetLabel.textContent = ok ? 'Internet' : 'Offline';
    inetLabel.className = ok ? 'text-green-500' : 'text-red-400';
  } catch {
    inetDot.className = 'inline-block w-2 h-2 rounded-full bg-red-500';
    inetLabel.textContent = 'Offline';
    inetLabel.className = 'text-red-400';
  }
}

// ── Search engine check & switcher ───────────────────
let searchEngines = [];

async function pollSearch() {
  try {
    const res = await fetch('/api/health/search');
    const { ok, engine, engines } = await res.json();
    searchDot.className = `inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500 pulse-dot' : 'bg-red-500'}`;
    searchLabel.textContent = engine ? `${engine} Search` : 'Search';
    searchToggle.className = `flex items-center gap-1 transition-colors ${ok ? 'text-green-500 hover:text-green-400' : 'text-red-400 hover:text-red-300'}`;
    if (engines) searchEngines = engines;
  } catch {
    searchDot.className = 'inline-block w-2 h-2 rounded-full bg-red-500';
    searchLabel.textContent = 'Search';
    searchToggle.className = 'flex items-center gap-1 transition-colors text-red-400 hover:text-red-300';
  }
}

function renderSearchDropdown() {
  searchDropdown.innerHTML = '';
  for (const eng of searchEngines) {
    const item = document.createElement('button');
    item.className = `w-full text-left px-3 py-1.5 text-xs transition-colors ${
      eng.active
        ? 'text-indigo-400 bg-indigo-500/10'
        : eng.configured
          ? 'text-zinc-300 hover:bg-zinc-700'
          : 'text-zinc-600 cursor-not-allowed'
    }`;
    item.textContent = eng.label + (eng.active ? ' ✓' : !eng.configured ? ' (no key)' : '');
    if (!eng.active && eng.configured) {
      item.addEventListener('click', () => switchSearchEngine(eng.id));
    }
    searchDropdown.appendChild(item);
  }
}

async function switchSearchEngine(engineId) {
  searchDropdown.classList.add('hidden');
  // Immediately show checking state
  searchDot.className = 'inline-block w-2 h-2 rounded-full bg-zinc-600 animate-pulse';
  searchLabel.textContent = 'Switching…';
  searchToggle.className = 'flex items-center gap-1 transition-colors text-zinc-500';
  try {
    await fetch('/api/health/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: engineId }),
    });
  } catch { /* pollSearch will pick up the state */ }
  await pollSearch();
}

searchToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !searchDropdown.classList.contains('hidden');
  searchDropdown.classList.toggle('hidden');
  if (!isOpen) renderSearchDropdown();
});

document.addEventListener('click', () => {
  searchDropdown.classList.add('hidden');
  toolUsageDropdown.classList.add('hidden');
  etradePanel.classList.add('hidden');
});

searchDropdown.addEventListener('click', (e) => e.stopPropagation());

// ── Tool usage tracking ─────────────────────────────
const toolUsageCounts = {};

function trackToolUse(name) {
  toolUsageCounts[name] = (toolUsageCounts[name] || 0) + 1;
  const total = Object.values(toolUsageCounts).reduce((a, b) => a + b, 0);
  toolUsageCount.textContent = total;
  toolUsageToggle.classList.remove('hidden');
}

function renderToolUsageDropdown() {
  toolUsageDropdown.innerHTML = '';
  const entries = Object.entries(toolUsageCounts).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of entries) {
    const item = document.createElement('div');
    item.className = 'px-3 py-1.5 text-xs flex justify-between gap-4';
    item.innerHTML = `<span class="text-zinc-400">${name}</span><span class="text-zinc-500">${count}</span>`;
    toolUsageDropdown.appendChild(item);
  }
}

toolUsageToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !toolUsageDropdown.classList.contains('hidden');
  toolUsageDropdown.classList.toggle('hidden');
  if (!isOpen) renderToolUsageDropdown();
});

toolUsageDropdown.addEventListener('click', (e) => e.stopPropagation());

// ── E*TRADE auth flow ────────────────────────────────
async function pollEtrade() {
  try {
    const res = await fetch('/api/etrade/status');
    const { authenticated, configured } = await res.json();
    if (!configured) return; // no keys, hide entirely
    etradeStatus.classList.remove('hidden');
    if (authenticated) {
      etradeDot.className = 'inline-block w-2 h-2 rounded-full bg-green-500 pulse-dot';
      etradeToggle.className = 'text-green-500';
      etradeToggle.textContent = 'E*TRADE';
    } else {
      etradeDot.className = 'inline-block w-2 h-2 rounded-full bg-amber-500';
      etradeToggle.className = 'text-amber-500 hover:text-amber-400 transition-colors';
      etradeToggle.textContent = 'E*TRADE (connect)';
    }
  } catch {}
}

function renderEtradePanel(authenticated) {
  if (authenticated) {
    etradePanelContent.innerHTML = `
      <div class="text-xs text-green-400 mb-1">Connected</div>
      <div class="text-xs text-zinc-500 mb-2">Ask the assistant about your accounts, balances, portfolio, or transactions.</div>
      <button id="etrade-disconnect-btn" class="w-full bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs font-medium px-3 py-1.5 rounded transition-colors">
        Disconnect &amp; Reconnect
      </button>`;
    document.getElementById('etrade-disconnect-btn').addEventListener('click', async () => {
      await fetch('/api/etrade/disconnect', { method: 'POST' });
      pollEtrade();
      renderEtradePanel(false);
    });
    return;
  }
  etradePanelContent.innerHTML = `
    <div id="etrade-step-1">
      <div class="text-xs text-zinc-400 mb-2">Connect your E*TRADE account (read-only)</div>
      <button id="etrade-auth-btn" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors">
        Open E*TRADE Authorization
      </button>
    </div>
    <div id="etrade-step-2" class="hidden mt-2">
      <div class="text-xs text-zinc-400 mb-2">Paste the verifier code from E*TRADE:</div>
      <div class="flex gap-2">
        <input id="etrade-verifier" type="text" placeholder="Verifier code"
          class="flex-1 bg-zinc-900 text-zinc-100 text-xs px-2 py-1.5 rounded border border-zinc-600 outline-none focus:border-zinc-400">
        <button id="etrade-submit-btn" class="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors">
          Connect
        </button>
      </div>
      <div id="etrade-error" class="text-red-400 text-xs mt-1 hidden"></div>
    </div>`;

  document.getElementById('etrade-auth-btn').addEventListener('click', async () => {
    const btn = document.getElementById('etrade-auth-btn');
    btn.textContent = 'Opening…';
    btn.disabled = true;
    try {
      const res = await fetch('/api/etrade/auth');
      const { url, error } = await res.json();
      if (error) throw new Error(error);
      window.open(url, '_blank');
      document.getElementById('etrade-step-2').classList.remove('hidden');
      btn.textContent = 'Opened — paste code below';
    } catch (err) {
      btn.textContent = 'Failed — try again';
      btn.disabled = false;
    }
  });

  document.getElementById('etrade-submit-btn').addEventListener('click', async () => {
    const verifier = document.getElementById('etrade-verifier').value.trim();
    const errEl = document.getElementById('etrade-error');
    if (!verifier) return;
    errEl.classList.add('hidden');
    try {
      const res = await fetch('/api/etrade/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verifier }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      etradePanel.classList.add('hidden');
      await pollEtrade();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
}

etradeToggle.addEventListener('click', async (e) => {
  e.stopPropagation();
  const isOpen = !etradePanel.classList.contains('hidden');
  etradePanel.classList.toggle('hidden');
  if (!isOpen) {
    const res = await fetch('/api/etrade/status');
    const { authenticated } = await res.json();
    renderEtradePanel(authenticated);
  }
});

etradePanel.addEventListener('click', (e) => e.stopPropagation());

// ── Slot panel ────────────────────────────────────────
let slotPanelOpen = false;

async function refreshSlots() {
  try {
    const slotsData = await api.fetchSlots();
    if (slotsData.length === 0) {
      slotsToggle.classList.add('hidden');
      return;
    }
    slotsToggle.classList.remove('hidden');
    const active = slotsData.filter(s => s.is_processing);
    if (active.length === 0) {
      slotsSummary.textContent = 'all idle';
    } else {
      const ids = active.map(s => `#${s.id}`).join(', ');
      slotsSummary.textContent = `${ids} active`;
    }

    // Update max context from actual slot data
    const maxCtx = slotsData[0]?.n_ctx;
    if (maxCtx && maxCtx !== state.maxContext) {
      state.maxContext = maxCtx;
      updateContextBar(state.lastTokenCount || 0);
    }

    if (slotPanelOpen) renderSlotCards(slotsData);
  } catch {
    slotsToggle.classList.add('hidden');
  }
}

function renderSlotCards(slotsData) {
  slotCards.innerHTML = '';
  for (const slot of slotsData) {
    const card = document.createElement('div');
    card.className = 'bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-xs min-w-[160px]';

    const stateLabel = !slot.is_processing ? 'Idle' : 'Processing';
    const stateColor = !slot.is_processing ? 'text-green-400' : 'text-amber-400';

    let cacheHtml = '';
    if (slot.n_ctx) {
      const used = slot.n_past || 0;
      const pct = Math.min(100, (used / slot.n_ctx) * 100);
      cacheHtml = `
        <div class="mt-2">
          <div class="flex justify-between text-zinc-500 mb-1">
            <span>Cache</span><span>${used}/${slot.n_ctx}</span>
          </div>
          <div class="w-full h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div class="h-full bg-indigo-500 rounded-full" style="width:${pct}%"></div>
          </div>
        </div>`;
    }

    const convName = slot.conversationId
      ? (state.conversations.find(c => c.id === slot.conversationId)?.title || 'Unknown')
      : 'None';

    card.innerHTML = `
      <div class="flex items-center justify-between mb-1">
        <span class="font-medium text-zinc-300">Slot ${slot.id}</span>
        <span class="${stateColor}">${stateLabel}</span>
      </div>
      <div class="text-zinc-500">Conv: <span class="text-zinc-400">${convName}</span></div>
      ${cacheHtml}
      <div class="mt-2 flex gap-1">
        ${slot.conversationId
          ? `<button data-action="unpin" data-conv="${slot.conversationId}" class="text-zinc-500 hover:text-zinc-300 transition-colors">Unpin</button>`
          : state.currentConversationId
            ? `<button data-action="pin" data-slot="${slot.id}" class="text-zinc-500 hover:text-zinc-300 transition-colors">Pin current</button>`
            : ''
        }
      </div>`;

    slotCards.appendChild(card);
  }

  // Attach pin/unpin handlers
  slotCards.querySelectorAll('[data-action="pin"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api.pinSlot(state.currentConversationId, parseInt(btn.dataset.slot));
      refreshSlots();
    });
  });
  slotCards.querySelectorAll('[data-action="unpin"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await api.unpinSlot(btn.dataset.conv);
      refreshSlots();
    });
  });
}

slotsToggle.addEventListener('click', () => {
  slotPanelOpen = !slotPanelOpen;
  slotPanel.classList.toggle('hidden', !slotPanelOpen);
  if (slotPanelOpen) refreshSlots();
});

// ── Event handlers ────────────────────────────────────
newChatBtn.addEventListener('click', async () => {
  const conv = await api.createConversation();
  state.currentConversationId = conv.id;
  await refreshSidebar();
  renderMessages([]);
  updateContextBar(0);
  input.focus();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const content = input.value.trim();
  const images = state.pendingImages.length > 0 ? [...state.pendingImages] : null;
  if (!content && !images) return;
  if (!state.currentConversationId) {
    const conv = await api.createConversation();
    state.currentConversationId = conv.id;
    await refreshSidebar();
    renderMessages([]);
    updateContextBar(0);
  }
  input.value = '';
  input.style.height = 'auto';
  clearPendingImages();
  await sendMessage(content, images);
});

// Auto-resize textarea
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
});

// Ctrl+Enter / Cmd+Enter to submit
input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    form.requestSubmit();
  }
});

// ── Image handling ────────────────────────────────────
function addPendingImage(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const base64 = dataUrl.split(',')[1];
    const mimeType = file.type || 'image/png';
    state.pendingImages.push({ dataUrl, base64, mimeType, name: file.name });
    renderImagePreviews();
  };
  reader.readAsDataURL(file);
}

function renderImagePreviews() {
  imagePreviewStrip.innerHTML = '';
  if (state.pendingImages.length === 0) {
    imagePreviewStrip.classList.add('hidden');
    return;
  }
  imagePreviewStrip.classList.remove('hidden');
  state.pendingImages.forEach((img, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'image-preview-thumb';
    const imgEl = document.createElement('img');
    imgEl.src = img.dataUrl;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'image-preview-remove';
    removeBtn.textContent = '✕';
    removeBtn.addEventListener('click', () => {
      state.pendingImages.splice(idx, 1);
      renderImagePreviews();
    });
    thumb.appendChild(imgEl);
    thumb.appendChild(removeBtn);
    imagePreviewStrip.appendChild(thumb);
  });
}

function clearPendingImages() {
  state.pendingImages = [];
  imagePreviewStrip.innerHTML = '';
  imagePreviewStrip.classList.add('hidden');
  imageInput.value = '';
}

attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', () => {
  for (const file of imageInput.files) {
    addPendingImage(file);
  }
  imageInput.value = '';
});

// Paste image from clipboard
input.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      addPendingImage(item.getAsFile());
    }
  }
});

// Drag and drop
form.addEventListener('dragover', (e) => {
  e.preventDefault();
  form.classList.add('drag-over');
});
form.addEventListener('dragleave', () => {
  form.classList.remove('drag-over');
});
form.addEventListener('drop', (e) => {
  e.preventDefault();
  form.classList.remove('drag-over');
  for (const file of e.dataTransfer.files) {
    if (file.type.startsWith('image/')) {
      addPendingImage(file);
    }
  }
});

// ── Prompt Library ────────────────────────────────────
promptsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  toolsDropdown.classList.add('hidden');
  promptsDropdown.classList.toggle('hidden');
});
promptsDropdown.addEventListener('click', (e) => e.stopPropagation());
toolsDropdown.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', (e) => {
  if (e.target !== promptsToggle) promptsDropdown.classList.add('hidden');
  if (e.target !== toolsToggle) toolsDropdown.classList.add('hidden');
});

// ── Tools Panel ──────────────────────────────────────
toolsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  promptsDropdown.classList.add('hidden');
  toolsDropdown.classList.toggle('hidden');
  if (!toolsDropdown.classList.contains('hidden')) refreshTools();
});

async function refreshTools() {
  try {
    const tools = await (await fetch('/api/tools')).json();
    renderTools(tools);
  } catch {}
}

function renderTools(tools) {
  toolsList.innerHTML = '';
  for (const t of tools) {
    const item = document.createElement('div');
    item.className = 'relative flex items-center gap-2 px-3 py-2 border-b border-zinc-700/50 hover:bg-zinc-700/30 transition-colors';

    const toggle = document.createElement('button');
    Object.assign(toggle.style, {
      width: '32px', height: '16px', borderRadius: '9999px', position: 'relative',
      flexShrink: '0', transition: 'background 0.2s', cursor: 'pointer', border: 'none',
      background: t.enabled ? '#6366f1' : '#52525b',
    });
    const knob = document.createElement('span');
    Object.assign(knob.style, {
      position: 'absolute', top: '2px', width: '12px', height: '12px',
      borderRadius: '9999px', background: 'white', transition: 'left 0.2s',
      left: t.enabled ? '16px' : '2px',
    });
    toggle.appendChild(knob);
    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await fetch(`/api/tools/${t.name}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !t.enabled }),
      });
      if (res.ok) refreshTools();
    });

    const name = document.createElement('span');
    Object.assign(name.style, { fontSize: '12px', fontWeight: '500', cursor: 'default', color: t.enabled ? '#e4e4e7' : '#71717a' });
    name.textContent = t.name;

    item.appendChild(toggle);
    item.appendChild(name);

    // Popup on hover — appended to body with inline styles to avoid clipping and Tailwind build issues
    let popup = null;
    item.addEventListener('mouseenter', () => {
      popup = document.createElement('div');
      Object.assign(popup.style, {
        position: 'fixed', zIndex: '9999', width: '300px', maxHeight: '400px',
        overflowY: 'auto', padding: '12px', background: '#18181b', border: '1px solid #52525b',
        borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', pointerEvents: 'none',
      });
      const descEl = document.createElement('div');
      Object.assign(descEl.style, { fontSize: '12px', color: '#d4d4d8', lineHeight: '1.6', whiteSpace: 'pre-wrap' });
      descEl.textContent = t.description;
      popup.appendChild(descEl);
      if (t.parameters.length > 0) {
        const paramsEl = document.createElement('div');
        Object.assign(paramsEl.style, { marginTop: '8px', fontSize: '10px', color: '#71717a' });
        paramsEl.textContent = 'params: ' + t.parameters.join(', ');
        popup.appendChild(paramsEl);
      }
      document.body.appendChild(popup);
      const rect = item.getBoundingClientRect();
      let top = rect.top;
      let left = rect.right + 8;
      if (left + 308 > window.innerWidth) left = rect.left - 308 - 8;
      if (top + popup.offsetHeight > window.innerHeight) top = window.innerHeight - popup.offsetHeight - 8;
      popup.style.top = top + 'px';
      popup.style.left = left + 'px';
    });
    item.addEventListener('mouseleave', () => {
      if (popup) { popup.remove(); popup = null; }
    });

    toolsList.appendChild(item);
  }
}

async function refreshPrompts() {
  try {
    const prompts = await (await fetch('/api/prompts')).json();
    renderPrompts(prompts);
  } catch {}
}

function renderPrompts(prompts) {
  promptList.innerHTML = '';
  let dragSrcEl = null;

  for (const p of prompts) {
    const item = document.createElement('div');
    item.className = 'group flex items-center gap-1 px-3 py-2 cursor-grab border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors';
    item.draggable = true;
    item.dataset.id = p.id;

    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      promptList.querySelectorAll('[data-id]').forEach(el => el.classList.remove('border-t-indigo-500'));
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      item.classList.add('border-t-indigo-500');
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('border-t-indigo-500');
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      item.classList.remove('border-t-indigo-500');
      if (dragSrcEl === item) return;
      promptList.insertBefore(dragSrcEl, item);
      const ids = [...promptList.querySelectorAll('[data-id]')].map(el => el.dataset.id);
      await fetch('/api/prompts/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'flex-1 text-xs text-zinc-300';
    titleSpan.textContent = p.title || p.text.slice(0, 60);

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/prompts/${p.id}`, { method: 'DELETE' });
      refreshPrompts();
    });

    item.addEventListener('click', () => {
      input.value = p.text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      input.focus();
    });

    item.appendChild(titleSpan);
    item.appendChild(delBtn);
    promptList.appendChild(item);
  }
}

clearPromptBtn.addEventListener('click', () => {
  input.value = '';
  input.style.height = 'auto';
  input.focus();
});

savePromptBtn.addEventListener('click', async () => {
  const text = input.value.trim();
  if (!text) return;
  savePromptBtn.disabled = true;
  savePromptBtn.textContent = '…';
  try {
    await fetch('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    input.value = '';
    input.style.height = 'auto';
    refreshPrompts();
  } finally {
    savePromptBtn.disabled = false;
    savePromptBtn.textContent = 'Save';
  }
});

// ── Init ──────────────────────────────────────────────
(async function init() {
  await refreshSidebar();
  refreshPrompts();
  pollHealth();
  setInterval(pollHealth, 5000);
  pollInternet();
  setInterval(pollInternet, 30000);
  pollSearch();
  setInterval(pollSearch, 60000);
  pollEtrade();
  refreshSlots();
  setInterval(refreshSlots, 5000);
})();
