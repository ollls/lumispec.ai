// ── State ──────────────────────────────────────────────
const state = {
  currentConversationId: null,
  conversations: [],
  abortController: null,
  healthy: false,
  maxContext: 131072,
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

// ── Code block rendering ─────────────────────────────
function langToExtension(lang) {
  const map = {
    rust: 'rs', python: 'py', javascript: 'js', typescript: 'ts',
    ruby: 'rb', golang: 'go', go: 'go', csharp: 'cs', cpp: 'cpp',
    c: 'c', java: 'java', kotlin: 'kt', swift: 'swift', bash: 'sh',
    shell: 'sh', zsh: 'sh', html: 'html', css: 'css', json: 'json',
    yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql', lua: 'lua',
    perl: 'pl', php: 'php', r: 'r', scala: 'scala', zig: 'zig',
    elixir: 'ex', erlang: 'erl', haskell: 'hs', ocaml: 'ml',
    markdown: 'md', xml: 'xml', dockerfile: 'Dockerfile', make: 'Makefile',
  };
  return map[lang?.toLowerCase()] || lang || 'txt';
}

function parseSegments(text) {
  const segments = [];
  const re = /^```(\w*)\s*$/gm;
  let lastIndex = 0;
  let openMatch = null;

  for (const match of text.matchAll(re)) {
    if (!openMatch) {
      // Opening fence
      if (match.index > lastIndex) {
        segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
      }
      openMatch = match;
    } else {
      // Closing fence
      const code = text.slice(openMatch.index + openMatch[0].length + 1, match.index);
      segments.push({ type: 'code', lang: openMatch[1] || '', content: code });
      openMatch = null;
    }
    lastIndex = match.index + match[0].length + 1;
  }

  // Unclosed fence = pending
  if (openMatch) {
    const code = text.slice(openMatch.index + openMatch[0].length + 1);
    segments.push({ type: 'code-pending', lang: openMatch[1] || '', content: code });
  } else if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

function renderFormattedContent(text, container) {
  container.innerHTML = '';
  const segments = parseSegments(text);

  for (const seg of segments) {
    if (seg.type === 'text') {
      const span = document.createElement('span');
      span.textContent = seg.content;
      container.appendChild(span);
    } else {
      const isPending = seg.type === 'code-pending';
      const wrapper = document.createElement('div');
      wrapper.className = 'code-block-wrapper' + (isPending ? ' code-block-pending' : '');

      // Toolbar
      const toolbar = document.createElement('div');
      toolbar.className = 'code-block-toolbar';

      const langLabel = document.createElement('span');
      langLabel.textContent = (seg.lang || 'code') + (isPending ? ' (streaming…)' : '');
      toolbar.appendChild(langLabel);

      if (!isPending) {
        const btnGroup = document.createElement('span');
        btnGroup.className = 'flex gap-1';

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(seg.content).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => copyBtn.textContent = 'Copy', 1500);
          });
        });

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => {
          const ext = langToExtension(seg.lang);
          const blob = new Blob([seg.content], { type: 'text/plain' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `code.${ext}`;
          a.click();
          URL.revokeObjectURL(a.href);
        });

        btnGroup.appendChild(copyBtn);
        btnGroup.appendChild(saveBtn);
        toolbar.appendChild(btnGroup);
      }

      wrapper.appendChild(toolbar);

      // Code block
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (seg.lang) code.className = `language-${seg.lang}`;

      if (!isPending && typeof hljs !== 'undefined' && seg.lang) {
        try {
          const result = hljs.highlight(seg.content, { language: seg.lang, ignoreIllegals: true });
          code.innerHTML = result.value;
          code.classList.add('hljs');
        } catch {
          code.textContent = seg.content;
        }
      } else if (!isPending && typeof hljs !== 'undefined') {
        try {
          const result = hljs.highlightAuto(seg.content);
          code.innerHTML = result.value;
          code.classList.add('hljs');
        } catch {
          code.textContent = seg.content;
        }
      } else {
        code.textContent = seg.content;
        if (!isPending) code.classList.add('hljs');
      }

      pre.appendChild(code);
      wrapper.appendChild(pre);
      container.appendChild(wrapper);
    }
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

// ── Messages ──────────────────────────────────────────
function renderMessages(messages) {
  responseArea.innerHTML = '';
  emptyState.classList.add('hidden');
  for (const msg of messages) {
    appendMessage(msg.role, msg.content);
  }
}

function appendMessage(role, text) {
  emptyState.classList.add('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'max-w-4xl mx-auto flex ' + (role === 'user' ? 'justify-end' : 'justify-start');

  const bubble = document.createElement('div');
  if (role === 'user') {
    bubble.className = 'max-w-[80%] bg-indigo-600/20 border border-indigo-500/30 text-zinc-100 rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap';
  } else if (role === 'error') {
    bubble.className = 'max-w-[80%] bg-red-600/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm leading-relaxed';
  } else {
    bubble.className = 'max-w-[80%] bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words';
  }

  if (role === 'assistant' && text) {
    renderFormattedContent(text, bubble);
  } else {
    bubble.textContent = text;
  }
  wrapper.appendChild(bubble);
  responseArea.appendChild(wrapper);
  responseArea.scrollTop = responseArea.scrollHeight;
  return bubble;
}

// ── Streaming ─────────────────────────────────────────
async function sendMessage(content) {
  if (!state.currentConversationId) return;

  appendMessage('user', content);
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

  let hasReasoning = false;

  state.abortController = new AbortController();
  let accumulated = '';
  let accumulatedReasoning = '';
  _lastRenderTime = 0;
  clearTimeout(_renderTimer);

  try {
    const res = await fetch(`/api/conversations/${state.currentConversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
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
    if (accumulated) renderFormattedContent(accumulated, contentSpan);
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
    healthLabel.textContent = ok ? 'Connected' : 'Disconnected';
    healthLabel.className = ok ? 'text-green-500' : 'text-red-400';
  } catch {
    state.healthy = false;
    healthDot.className = 'inline-block w-2 h-2 rounded-full bg-red-500';
    healthLabel.textContent = 'Disconnected';
    healthLabel.className = 'text-red-400';
  }
}

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
  if (!content) return;
  if (!state.currentConversationId) {
    const conv = await api.createConversation();
    state.currentConversationId = conv.id;
    await refreshSidebar();
    renderMessages([]);
    updateContextBar(0);
  }
  input.value = '';
  input.style.height = 'auto';
  await sendMessage(content);
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

// ── Init ──────────────────────────────────────────────
(async function init() {
  await refreshSidebar();
  pollHealth();
  setInterval(pollHealth, 5000);
  refreshSlots();
  setInterval(refreshSlots, 5000);
})();
