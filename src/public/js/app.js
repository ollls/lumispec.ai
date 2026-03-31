// ── State ──────────────────────────────────────────────
const state = {
  currentConversationId: localStorage.getItem('activeConversationId') || null,
  conversations: [],
  abortController: null,
  healthy: false,
  maxContext: 131072,
  pendingImages: [], // { dataUrl, mimeType, name }
  appletsEnabled: localStorage.getItem('appletsEnabled') !== 'false', // default true
  autorunEnabled: localStorage.getItem('autorunEnabled') === 'true', // default false
  thinkEnabled: localStorage.getItem('thinkEnabled') !== 'false', // default true
  sessionType: null, // current session color: 'blue'|'cyan'|'amber'|'coral'|'sgreen'|'navy'|'lavender'
  sessionColors: JSON.parse(localStorage.getItem('sessionColors') || '{}'), // convId → sessionType
  location: '', // from server config (LOCATION env var)
  compactColors: new Set(), // colors that have compact prompts configured
  listMode: false, // bullet list editing mode
  reviewEnabled: localStorage.getItem('reviewEnabled') === 'true', // pause after each task step
  precisionEnabled: localStorage.getItem('precisionEnabled') === 'true', // strict computation mode
};

// Colorize diff text — lines starting with +/-/@@ get green/red/cyan
function colorizeDiff(text) {
  return text.split('\n').map(line => {
    const esc = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    if (line.startsWith('+')) return `<span class="text-green-500">${esc}</span>`;
    if (line.startsWith('-')) return `<span class="text-red-400">${esc}</span>`;
    if (line.startsWith('@@')) return `<span class="text-cyan-500">${esc}</span>`;
    return `<span class="text-zinc-400">${esc}</span>`;
  }).join('\n');
}

// Dark session colors that are unreadable on dark backgrounds → lighter text variants
function textSafeColor(color) {
  const lightMap = { '#1b2a4a': '#6B8FBF' };
  return lightMap[(color || '').toLowerCase()] || color;
}

let _elapsedInterval = null;
function startElapsedTimer() {
  const t0 = Date.now();
  elapsedTimer.classList.remove('hidden');
  elapsedTimer.textContent = '0s';
  clearInterval(_elapsedInterval);
  _elapsedInterval = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    elapsedTimer.textContent = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }, 1000);
}
function stopElapsedTimer() {
  clearInterval(_elapsedInterval);
  _elapsedInterval = null;
}

function flashMsg(text) {
  let el = document.getElementById('flash-msg');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash-msg';
    el.className = 'text-red-500 text-sm mt-2 transition-opacity duration-300';
    document.getElementById('empty-state').appendChild(el);
  }
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

function requireSession() {
  if (!state.currentConversationId || !state.sessionType) {
    flashMsg('Create a session first');
    return false;
  }
  return true;
}

// ── DOM refs ──────────────────────────────────────────
const sidebar = document.getElementById('conversation-list');
const newChatButtons = document.querySelectorAll('.session-btn');
const responseArea = document.getElementById('response-area');
const emptyState = document.getElementById('empty-state');
const form = document.getElementById('prompt-form');
const input = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const llmDot = document.getElementById('llm-dot');
const llmLabel = document.getElementById('llm-label');
const llmToggle = document.getElementById('llm-toggle');
const llmDropdown = document.getElementById('llm-dropdown');
const slotsToggle = document.getElementById('slots-toggle');
const slotsSummary = document.getElementById('slots-summary');
const slotPanel = document.getElementById('slot-panel');
const slotCards = document.getElementById('slot-cards');
const contextBar = document.getElementById('context-bar');
const contextLabel = document.getElementById('context-label');
const elapsedTimer = document.getElementById('elapsed-timer');
const inetDot = document.getElementById('inet-dot');
const inetLabel = document.getElementById('inet-label');
const searchDot = document.getElementById('search-dot');
const searchLabel = document.getElementById('search-label');
const searchToggle = document.getElementById('search-toggle');
const searchDropdown = document.getElementById('search-dropdown');
const toolUsageToggle = document.getElementById('tool-usage-toggle');
const toolUsageCount = document.getElementById('tool-usage-count');
const toolUsageDropdown = document.getElementById('tool-usage-dropdown');
const searchStatus = document.getElementById('search-status');
const pluginStatusContainer = document.getElementById('plugin-status-container');
const imageInput = document.getElementById('image-input');
const attachBtn = document.getElementById('attach-btn');
const imagePreviewStrip = document.getElementById('image-preview-strip');
const appletToggle = document.getElementById('applet-toggle');
const autorunToggle = document.getElementById('autorun-toggle');
const thinkToggle = document.getElementById('think-toggle');
const reviewToggle = document.getElementById('review-toggle');
const reviewToggleLabel = document.getElementById('review-toggle-label');
const precisionToggle = document.getElementById('precision-toggle');
const savePromptBtn = document.getElementById('save-prompt-btn');
const saveSessionBtn = document.getElementById('save-session-btn');
const sessionList = document.getElementById('session-list');
const sessionsToggle = document.getElementById('sessions-toggle');
const sessionsDropdown = document.getElementById('sessions-dropdown');
const saveCompactBtn = document.getElementById('save-compact-btn');
const compactList = document.getElementById('compact-list');
const compactsToggle = document.getElementById('compacts-toggle');
const compactsDropdown = document.getElementById('compacts-dropdown');
const clearPromptBtn = document.getElementById('clear-prompt-btn');
const listModeBtn = document.getElementById('list-mode-btn');
const taskList = document.getElementById('task-list');
const tasksToggle = document.getElementById('tasks-toggle');
const tasksDropdown = document.getElementById('tasks-dropdown');
const promptList = document.getElementById('prompt-list');
const promptsToggle = document.getElementById('prompts-toggle');
const promptsDropdown = document.getElementById('prompts-dropdown');
const templateList = document.getElementById('template-list');
const templatesToggle = document.getElementById('templates-toggle');
const templatesDropdown = document.getElementById('templates-dropdown');
const pluginsToggle = document.getElementById('plugins-toggle');
const pluginConfigPanel = document.getElementById('plugin-config-panel');
const pluginConfigList = document.getElementById('plugin-config-list');
const pluginConfigClose = document.getElementById('plugin-config-close');

// ── Extra session buttons expand/collapse ────────────
{
  const expandBtn = document.getElementById('session-expand');
  const extraBtns = document.getElementById('session-extra');
  const expanded = localStorage.getItem('sessionExpanded') === 'true';
  if (expanded) {
    extraBtns.classList.remove('hidden');
    extraBtns.classList.add('flex');
    expandBtn.textContent = '‹';
  }
  expandBtn.addEventListener('click', () => {
    const show = extraBtns.classList.contains('hidden');
    extraBtns.classList.toggle('hidden', !show);
    extraBtns.classList.toggle('flex', show);
    expandBtn.textContent = show ? '‹' : '›';
    localStorage.setItem('sessionExpanded', show);
  });
}

// ── Refine prompt from reasoning ─────────────────────
function addRefineButton(details, getPrompt, getReasoning) {
  const btn = document.createElement('button');
  btn.textContent = 'Refine';
  Object.assign(btn.style, {
    fontSize: '10px', padding: '1px 8px', borderRadius: '4px', marginLeft: '8px',
    background: '#3f3f46', color: '#a1a1aa', border: 'none', cursor: 'pointer',
    verticalAlign: 'middle',
  });
  btn.addEventListener('mouseenter', () => { btn.style.background = '#52525b'; btn.style.color = '#e4e4e7'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = '#3f3f46'; btn.style.color = '#a1a1aa'; });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const prompt = getPrompt();
    const reasoning = getReasoning();
    if (!prompt || !reasoning || reasoning.length < 20) return;
    const origText = btn.textContent;
    btn.textContent = '…';
    btn.style.pointerEvents = 'none';
    try {
      const res = await fetch(`/api/conversations/${state.currentConversationId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, reasoning }),
      });
      if (!res.ok) return;
      const { refined, changed } = await res.json();
      if (changed) {
        input.value = refined;
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        input.focus();
        btn.textContent = 'Loaded';
      } else {
        btn.textContent = 'Already optimal';
      }
      setTimeout(() => { btn.textContent = origText; }, 2000);
    } catch {
      btn.textContent = origText;
    } finally {
      btn.style.pointerEvents = 'auto';
    }
  });
  details.querySelector('summary').appendChild(btn);
}

// ── Stop button ─────────────────────────────────────
stopBtn.addEventListener('click', () => {
  if (state.abortController) {
    state.abortController.abort();
    state.abortController = null;
  }
});

// ── Click-to-copy word from assistant messages ───────
responseArea.addEventListener('click', (e) => {
  const sel = window.getSelection();
  if (sel && sel.toString().trim().length > 0) return; // text was selected, don't interfere
  // Only capture from assistant bubbles (not user bubbles or other elements)
  const node = e.target.closest && e.target.closest('.justify-start > div');
  if (!node || !responseArea.contains(node)) return;
  // Find the text node and offset at click position
  let textNode, offset;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (!pos || !pos.offsetNode) return;
    textNode = pos.offsetNode; offset = pos.offset;
  } else if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (!range) return;
    textNode = range.startContainer; offset = range.startOffset;
  } else return;
  if (textNode.nodeType !== Node.TEXT_NODE) return;
  const text = textNode.textContent;
  // Find word boundaries (non-space chars around click position)
  let start = offset, end = offset;
  while (start > 0 && text[start - 1] !== ' ' && text[start - 1] !== '\n') start--;
  while (end < text.length && text[end] !== ' ' && text[end] !== '\n') end++;
  const word = text.slice(start, end).trim();
  if (!word) return;
  // Insert word at cursor position in textarea (or append with space)
  const curPos = input.selectionStart || input.value.length;
  const before = input.value.slice(0, curPos);
  const after = input.value.slice(curPos);
  const spaceBefore = before.length && !before.endsWith(' ') && !before.endsWith('\n') ? ' ' : '';
  input.value = before + spaceBefore + word + after;
  input.focus();
  const newPos = curPos + spaceBefore.length + word.length;
  input.selectionStart = input.selectionEnd = newPos;
});

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
  async pinConversation(id) {
    const res = await fetch(`/api/conversations/${id}/pin`, { method: 'POST' });
    return res.json();
  },
  async unpinConversation(id) {
    const res = await fetch(`/api/conversations/${id}/unpin`, { method: 'POST' });
    return res.json();
  },
  async compactConversation(id) {
    const color = state.sessionColors[id] || null;
    const res = await fetch(`/api/conversations/${id}/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color }),
    });
    return res.json();
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
    item.className = `group flex items-center gap-2 py-3 cursor-pointer border-b border-zinc-800/50 transition-colors ${
      isActive ? 'bg-zinc-800/70' : 'hover:bg-zinc-900'
    }`;

    // Color strip on left edge matching session color
    const convSession = state.sessionColors[conv.id];
    const strip = document.createElement('div');
    strip.className = 'self-stretch w-1 shrink-0 rounded-r';
    if (convSession) {
      const c = getComputedStyle(document.documentElement).getPropertyValue(`--btn-${convSession}`).trim();
      if (c) strip.style.backgroundColor = c;
    }
    item.appendChild(strip);

    const title = document.createElement('span');
    title.className = 'flex-1 text-sm truncate pl-3 ' + (isActive ? 'text-zinc-100' : 'text-zinc-400');
    title.textContent = conv.title;
    if (convSession) {
      const c = getComputedStyle(document.documentElement).getPropertyValue(`--btn-${convSession}`).trim();
      if (c) title.style.color = textSafeColor(c);
    }

    const pinBtn = document.createElement('button');
    pinBtn.className = conv.pinned
      ? 'text-amber-400 px-1 shrink-0 cursor-pointer'
      : 'text-zinc-600 hover:text-amber-400 px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 cursor-pointer';
    const pinSvg = conv.pinned
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1"><path d="M16 2L20.5 6.5L18 9L19 16L14 11L8 17V19H6V17L12 11L7 6L14 7L16.5 4.5Z"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 2L20.5 6.5L18 9L19 16L14 11L8 17V19H6V17L12 11L7 6L14 7L16.5 4.5Z"/></svg>';
    pinBtn.innerHTML = pinSvg;
    pinBtn.title = conv.pinned ? 'Unpin (remove persistence)' : 'Pin (persist across restarts)';
    pinBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (conv.pinned) {
        await api.unpinConversation(conv.id);
      } else {
        await api.pinConversation(conv.id);
      }
      await refreshSidebar();
    });

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

    // Compact button — only for pinned conversations with messages AND a compact prompt for this color
    let compactBtn = null;
    const convColor = state.sessionColors[conv.id];
    if (conv.pinned && (conv.messageCount || 0) > 2 && convColor && state.compactColors.has(convColor)) {
      compactBtn = document.createElement('button');
      compactBtn.className = 'text-zinc-600 hover:text-cyan-400 px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 cursor-pointer';
      compactBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
      compactBtn.title = 'Compact — LLM summarizes conversation';
      let compactConfirmTimeout = null;
      compactBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (compactBtn.dataset.confirm) {
          clearTimeout(compactConfirmTimeout);
          compactBtn.textContent = '...';
          compactBtn.disabled = true;
          await api.compactConversation(conv.id);
          if (conv.id === state.currentConversationId) {
            const updated = await api.getConversation(conv.id);
            renderMessages(updated.messages);
          }
          await refreshSidebar();
        } else {
          compactBtn.dataset.confirm = '1';
          compactBtn.innerHTML = '<span class="text-red-400 text-xs font-medium">Compact?</span>';
          compactConfirmTimeout = setTimeout(() => {
            delete compactBtn.dataset.confirm;
            compactBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h16M4 17h10"/></svg>';
          }, 3000);
        }
      });
    }

    item.addEventListener('click', () => switchConversation(conv.id));
    item.appendChild(title);
    if (compactBtn) item.appendChild(compactBtn);
    item.appendChild(pinBtn);
    item.appendChild(delBtn);
    sidebar.appendChild(item);
  }
}

async function switchConversation(id) {
  if (id === state.currentConversationId) return;
  // Abort any in-flight stream
  if (state.abortController) state.abortController.abort();

  state.currentConversationId = id;
  persistActiveConversation();
  // Restore session color for this conversation
  const savedType = state.sessionColors[id] || null;
  state.sessionType = savedType;
  const color = savedType ? getComputedStyle(document.documentElement).getPropertyValue(`--btn-${savedType}`).trim() : '';
  input.style.borderColor = color || '';
  updateInputLock();
  renderSidebar();

  const conv = await api.getConversation(id);
  renderMessages(conv.messages);
  updateContextBar(conv.tokenCount);
}

async function deleteConversation(id) {
  await api.deleteConversation(id);
  delete state.sessionColors[id];
  localStorage.setItem('sessionColors', JSON.stringify(state.sessionColors));
  if (state.currentConversationId === id) {
    state.currentConversationId = null;
    state.sessionType = null;
    input.style.borderColor = '';
    persistActiveConversation();
    updateInputLock();
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

// ── Applet extraction & rendering ─────────────────────
const APPLET_RE = /<applet\s+type=["']([^"']*)["'][^>]*>([\s\S]*?)<\/applet>/gi;
const MAX_APPLET_SIZE = 50 * 1024; // 50KB

function extractApplets(text) {
  const applets = [];
  const cleaned = text.replace(APPLET_RE, (_match, type, html) => {
    const idx = applets.length;
    applets.push({ type: type.toLowerCase(), html: html.trim() });
    return `<div data-applet="${idx}"></div>`;
  });
  return { cleaned, applets };
}

function createAppletIframe(applet) {
  let html = applet.html;

  // Validate: html type applets are always valid; others need <script>, <svg>, <canvas>, or <img>
  if (applet.type !== 'html' && !/<script[\s>]|<svg[\s>]|<canvas[\s>]|<img[\s>]/i.test(html)) {
    // Fallback: collapsible code block
    const details = document.createElement('details');
    details.className = 'applet-fallback';
    details.innerHTML = `<summary style="cursor:pointer;color:#a1a1aa;font-size:0.8125rem;margin:0.5rem 0">Applet (${applet.type}) — click to view source</summary><pre style="background:#18181b;border:1px solid #3f3f46;border-radius:0.5rem;padding:1rem;overflow-x:auto;font-size:0.8125rem;color:#e4e4e7"><code></code></pre>`;
    details.querySelector('code').textContent = html;
    return details;
  }

  // Size cap
  if (html.length > MAX_APPLET_SIZE) {
    const div = document.createElement('div');
    div.style.cssText = 'color:#ef4444;font-size:0.8125rem;padding:0.5rem';
    div.textContent = `Applet too large (${(html.length / 1024).toFixed(1)}KB > 50KB limit)`;
    return div;
  }

  // Inject Chart.js for chartjs type if missing
  if (applet.type === 'chartjs' && !html.includes('/lib/chart.min.js')) {
    html = html.replace(/<head>/i, '<head>\n<script src="/lib/chart.min.js"><\/script>');
    // If no <head> tag, prepend
    if (!/<head>/i.test(html)) {
      html = `<head><script src="/lib/chart.min.js"><\/script></head>\n${html}`;
    }
  }

  // Inject style reset to prevent scrollbars inside iframe
  const iframeReset = '<style>html{overflow:hidden}body{min-height:0!important;margin:0;overflow:visible}img{max-width:100%;height:auto}</style>';
  if (html.includes('<head>')) {
    html = html.replace(/<head>/i, '<head>' + iframeReset);
  } else if (html.includes('<html>')) {
    html = html.replace(/<html>/i, '<html><head>' + iframeReset + '</head>');
  } else {
    html = iframeReset + html;
  }

  // Inject auto-resize script if no postMessage present
  if (!html.includes('postMessage')) {
    const resizeScript = `<script>
function _rsz(){var d=document.documentElement,b=document.body,od=d.style.overflow,ob=b.style.overflow;d.style.overflow='visible';b.style.overflow='visible';var h=Math.max(b.scrollHeight,b.offsetHeight,d.scrollHeight)+2;d.style.overflow=od;b.style.overflow=ob;window.parent.postMessage({type:'resize',height:h},'*');}
new ResizeObserver(_rsz).observe(document.body);
window.addEventListener('load',_rsz);
document.querySelectorAll('img').forEach(i=>{i.complete?_rsz():i.addEventListener('load',_rsz);});
new MutationObserver(()=>{document.querySelectorAll('img').forEach(i=>{if(!i._rsz){i._rsz=1;i.addEventListener('load',_rsz);}});}).observe(document.body,{childList:true,subtree:true});
<\/script>`;
    html = html.replace(/<\/body>/i, resizeScript + '</body>');
    if (!/<\/body>/i.test(html)) html += resizeScript;
  }

  const iframe = document.createElement('iframe');
  iframe.className = 'applet-iframe';
  iframe.sandbox = 'allow-scripts allow-same-origin';
  iframe.srcdoc = html;
  iframe.style.cssText = 'width:100%;height:500px;border:1px solid #3f3f46;border-radius:0.5rem;overflow:hidden;display:block';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'bg-amber-600 hover:bg-amber-500 text-white text-xs font-bold px-3 py-1 rounded mt-1 transition-colors';
  saveBtn.textContent = 'Save as Template';
  saveBtn.addEventListener('click', async () => {
    const name = prompt('Template name:');
    if (!name) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving\u2026';
    try {
      await fetch('/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: applet.type, html: applet.html }),
      });
      saveBtn.textContent = 'Saved \u2713';
      saveBtn.className = 'bg-emerald-600 text-white text-xs font-bold px-3 py-1 rounded mt-1';
      refreshTemplates();
    } catch {
      saveBtn.textContent = 'Save failed';
      saveBtn.disabled = false;
    }
  });

  const wrapper = document.createElement('div');
  wrapper.className = 'applet-wrapper';
  wrapper.appendChild(iframe);
  wrapper.appendChild(saveBtn);
  return wrapper;
}

// Global resize listener for applet iframes (registered once)
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'resize' || typeof e.data.height !== 'number') return;
  const MAX_IFRAME_H = 20000;
  const height = Math.max(100, Math.min(MAX_IFRAME_H, e.data.height));
  document.querySelectorAll('.applet-iframe').forEach(iframe => {
    if (iframe.contentWindow === e.source) {
      iframe.style.height = height + 'px';
      iframe.style.overflow = e.data.height > MAX_IFRAME_H ? 'auto' : 'hidden';
    }
  });
});

function renderFormattedContent(text, container, { renderMermaid = false } = {}) {
  // Extract applets BEFORE DOMPurify (which strips <applet> tags)
  const { cleaned, applets } = extractApplets(text);

  const raw = marked.parse(cleaned);
  container.innerHTML = DOMPurify.sanitize(raw);
  container.classList.add('markdown-body');

  // Replace placeholders with applet iframes
  if (applets.length > 0) {
    applets.forEach((applet, idx) => {
      const placeholder = container.querySelector(`[data-applet="${idx}"]`);
      if (placeholder) {
        placeholder.replaceWith(createAppletIframe(applet));
      }
    });
    // Expand bubble to full width when applets are present
    const bubble = container.parentElement;
    if (bubble) {
      bubble.classList.remove('max-w-[80%]');
      bubble.classList.add('max-w-full', 'w-full');
    }
  }

  if (renderMermaid && typeof mermaid !== 'undefined') {
    container.querySelectorAll('code.language-mermaid').forEach(async (codeEl) => {
      const pre = codeEl.parentElement;
      let source = codeEl.textContent;
      // Auto-convert pie charts with negative values to xychart-beta bar charts
      if (/^\s*pie\b/i.test(source)) {
        const entries = [...source.matchAll(/"([^"]+)"\s*:\s*([-\d.]+)/g)];
        if (entries.some(m => parseFloat(m[2]) < 0)) {
          const labels = entries.map(m => `"${m[1]}"`).join(', ');
          const values = entries.map(m => m[2]).join(', ');
          const titleMatch = source.match(/title\s+(.+)/i);
          const title = titleMatch ? titleMatch[1].trim() : 'Chart';
          source = `xychart-beta\n    title "${title}"\n    x-axis [${labels}]\n    bar [${values}]`;
          codeEl.textContent = source;
        }
      }
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

// ── Extract image URLs from tool results ──────────────
const IMG_URL_RE = /https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp|svg|bmp)(?:\?\S*)?/gi;
function extractImageUrls(obj, depth = 0) {
  if (!obj || depth > 5) return [];
  const urls = new Set();
  if (typeof obj === 'string') {
    for (const m of obj.matchAll(IMG_URL_RE)) urls.add(m[0]);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      for (const u of extractImageUrls(item, depth + 1)) urls.add(u);
    }
  } else if (typeof obj === 'object') {
    for (const [key, val] of Object.entries(obj)) {
      if (key.startsWith('_') && key !== '_images') continue; // skip _markdown etc. but keep _images
      for (const u of extractImageUrls(val, depth + 1)) urls.add(u);
    }
  }
  return [...urls];
}

// ── Messages ──────────────────────────────────────────
function renderMessages(messages) {
  responseArea.innerHTML = '';
  emptyState.classList.add('hidden');
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const text = typeof msg.content === 'object' ? msg.content.text : msg.content;
    const images = typeof msg.content === 'object' ? msg.content.images : undefined;
    const reasoning = typeof msg.content === 'object' ? msg.content.reasoning : undefined;
    const toolUses = typeof msg.content === 'object' ? msg.content.toolUses : undefined;
    appendMessage(msg.role, text, images, { reasoning, toolUses, msgIndex: i });
  }
}

async function regenerateFrom(wrapper) {
  const msgIndex = parseInt(wrapper.dataset.msgIndex, 10);
  if (isNaN(msgIndex)) return;
  const convId = state.currentConversationId;
  const conv = await api.getConversation(convId);
  const msg = conv.messages[msgIndex];
  if (!msg || msg.role !== 'user') return;
  const text = typeof msg.content === 'object' ? msg.content.text : msg.content;
  const images = typeof msg.content === 'object' ? msg.content.images : undefined;
  // Truncate backend messages from this point
  await fetch(`/api/conversations/${convId}/messages`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fromIndex: msgIndex }),
  });
  // Remove DOM elements from this wrapper onward
  while (wrapper.nextSibling) wrapper.nextSibling.remove();
  wrapper.remove();
  // Re-send — sendMessage will append user+assistant bubbles
  await sendMessage(text, images);
  // Re-render with proper msgIndex on all bubbles
  const updated = await api.getConversation(convId);
  renderMessages(updated.messages);
}

function appendMessage(role, text, images, meta = {}) {
  emptyState.classList.add('hidden');
  const wrapper = document.createElement('div');
  wrapper.className = 'max-w-4xl mx-auto flex ' + (role === 'user' ? 'justify-end' : 'justify-start');
  if (meta.msgIndex !== undefined) wrapper.dataset.msgIndex = meta.msgIndex;

  const bubble = document.createElement('div');
  if (role === 'user') {
    bubble.className = 'relative group max-w-[80%] bg-indigo-600/20 border border-indigo-500/30 text-zinc-100 rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap';
  } else if (role === 'error') {
    bubble.className = 'max-w-[80%] bg-red-600/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 text-sm leading-relaxed';
  } else {
    bubble.className = 'max-w-[80%] bg-zinc-800/60 border border-zinc-700/50 text-zinc-200 rounded-xl px-4 py-3 text-sm leading-relaxed break-words';
  }

  // Regenerate button on user bubbles
  if (role === 'user' && meta.msgIndex !== undefined) {
    const regenBtn = document.createElement('button');
    regenBtn.className = 'absolute top-1 right-1.5 opacity-0 group-hover:opacity-50 hover:!opacity-100 text-zinc-300 hover:text-indigo-300 transition-opacity text-xs leading-none p-1';
    regenBtn.textContent = '↻';
    regenBtn.title = 'Regenerate from here';
    regenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      regenerateFrom(wrapper);
    });
    bubble.appendChild(regenBtn);
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
    // Refine button — get preceding user message prompt from server
    if (meta.msgIndex !== undefined && meta.msgIndex > 0) {
      const reasoning = meta.reasoning;
      const msgIdx = meta.msgIndex;
      addRefineButton(details, () => {
        // Fetch synchronously from cached conversation data isn't possible,
        // so we grab text node content from the DOM (skip regen button text)
        const prevWrapper = responseArea.querySelector(`[data-msg-index="${msgIdx - 1}"]`);
        if (!prevWrapper) return '';
        const bubble = prevWrapper.querySelector('.whitespace-pre-wrap');
        if (!bubble) return '';
        // Get only text node content, skip button children
        let text = '';
        for (const node of bubble.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
        }
        return text.trim();
      }, () => reasoning);
    }
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
      // Collapsible image thumbnails for stored tool results
      try {
        const parsedTu = JSON.parse(tu.result);
        const tuImageUrls = extractImageUrls(parsedTu);
        if (tuImageUrls.length > 0) {
          const imgDetail = document.createElement('details');
          imgDetail.className = 'mb-2 border-t border-zinc-800 pt-2';
          const imgSummary = document.createElement('summary');
          imgSummary.className = 'text-xs text-zinc-400 cursor-pointer hover:text-zinc-300 transition-colors select-none';
          imgSummary.textContent = `📷 Photos (${tuImageUrls.slice(0, 12).length})`;
          imgDetail.appendChild(imgSummary);
          const imgGrid = document.createElement('div');
          imgGrid.className = 'msg-image-grid mt-2';
          for (const url of tuImageUrls.slice(0, 12)) {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'msg-image-thumb';
            img.loading = 'lazy';
            img.alt = '';
            img.addEventListener('click', () => {
              const overlay = document.createElement('div');
              overlay.className = 'image-overlay';
              const full = document.createElement('img');
              full.src = url;
              full.className = 'image-overlay-img';
              overlay.appendChild(full);
              overlay.addEventListener('click', () => overlay.remove());
              document.body.appendChild(overlay);
            });
            img.addEventListener('error', () => img.remove());
            imgGrid.appendChild(img);
          }
          imgDetail.appendChild(imgGrid);
          container.appendChild(imgDetail);
        }
      } catch {}
    }
    bubble.appendChild(container);
  }

  if (role === 'assistant' && text) {
    const contentSpan = document.createElement('span');
    bubble.appendChild(contentSpan);
    renderFormattedContent(text, contentSpan, { renderMermaid: true });
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
async function sendMessage(content, images, { sessionInit = false } = {}) {
  if (!state.currentConversationId) return;

  appendMessage('user', content, images);
  const bubble = appendMessage('assistant', '');
  sendBtn.disabled = true;
  stopBtn.classList.remove('hidden');
  startElapsedTimer();

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
        applets: state.appletsEnabled,
        autorun: state.autorunEnabled,
        precision: state.precisionEnabled,
        sessionInit: sessionInit || false,
      }),
      signal: state.abortController.signal,
    });

    // sessionInit flag consumed by POST body above
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
            if (data.reasoning && state.thinkEnabled) {
              if (!hasReasoning) {
                hasReasoning = true;
                reasoningDetails.open = true;
                bubble.insertBefore(reasoningDetails, contentSpan);
              }
              accumulatedReasoning += data.reasoning;
              reasoningBody.textContent = accumulatedReasoning;
              responseArea.scrollTop = responseArea.scrollHeight;
            }
            if (data.tool_content && state.thinkEnabled) {
              // Show LLM's text during tool rounds so user knows it's not hung
              if (!hasToolUse) {
                hasToolUse = true;
                bubble.insertBefore(toolUseContainer, contentSpan);
              }
              if (!toolUseContainer._thinkingEl) {
                const el = document.createElement('details');
                el.className = 'mb-2 text-zinc-500 text-xs';
                el.open = true;
                el.innerHTML = '<summary class="cursor-pointer select-none text-zinc-500 hover:text-zinc-400"><span class="mr-1">⏳</span> Working...</summary>';
                const body = document.createElement('pre');
                body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-40 overflow-y-auto slim-scrollbar';
                el.appendChild(body);
                toolUseContainer.appendChild(el);
                toolUseContainer._thinkingEl = body;
              }
              toolUseContainer._thinkingEl.textContent += data.tool_content;
              responseArea.scrollTop = responseArea.scrollHeight;
            }
            if (data.tool_status && state.thinkEnabled) {
              // Show inline status for slow operations (prebook, book, cancel)
              if (!hasToolUse) {
                hasToolUse = true;
                bubble.insertBefore(toolUseContainer, contentSpan);
              }
              // Remove previous status if any
              const prev = toolUseContainer.querySelector('.tool-status-msg');
              if (prev) prev.remove();
              const statusEl = document.createElement('div');
              statusEl.className = 'tool-status-msg text-xs text-indigo-400 py-1 animate-pulse';
              statusEl.textContent = data.tool_status;
              toolUseContainer.appendChild(statusEl);
              responseArea.scrollTop = responseArea.scrollHeight;
            }
            if (data.tool_use) {
              // Update source dir label when project is switched
              if (data.tool_use.name === 'source_project') {
                try {
                  const r = JSON.parse(data.tool_use.result);
                  if (r.switched || r.current) {
                    const dir = r.current || '';
                    const short = dir.replace(/^\/home\/[^/]+/, '~');
                    const projBtn = document.getElementById('project-btn');
                    projBtn.title = 'Project: ' + short;
                  }
                } catch {}
              }
              // Clear status and "Working..." indicators when a tool result arrives
              const statusMsg = toolUseContainer.querySelector('.tool-status-msg');
              if (statusMsg) statusMsg.remove();
              if (toolUseContainer._thinkingEl) {
                const thinkDetails = toolUseContainer._thinkingEl.closest('details');
                thinkDetails.open = false;
                thinkDetails.querySelector('summary').innerHTML = '<span class="mr-1">💭</span> Thought process';
                delete toolUseContainer._thinkingEl;
              }
              trackToolUse(data.tool_use.name);
              if (!state.thinkEnabled) {
                // Skip rendering tool use details
              } else {
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
              // Parse result to check for _markdown and build summary info
              let parsedResult = null;
              try { parsedResult = JSON.parse(data.tool_use.result); } catch {}

              // Build richer summary line with key metadata
              let metaTag = '';
              if (parsedResult && !parsedResult.error) {
                const counts = [];
                if (parsedResult.totalCount != null) counts.push(`${parsedResult.totalCount} items`);
                else if (parsedResult.totalPositions != null) counts.push(`${parsedResult.totalPositions} positions`);
                else if (parsedResult.totalPairs != null) counts.push(`${parsedResult.totalPairs} pairs`);
                // Source tool metadata
                if (parsedResult.path && parsedResult._diff) {
                  counts.push(parsedResult.path);
                  if (parsedResult.linesRemoved) counts.push(`-${parsedResult.linesRemoved}`);
                  if (parsedResult.linesAdded) counts.push(`+${parsedResult.linesAdded}`);
                  if (parsedResult.deleted) counts.push('deleted');
                  if (parsedResult.created) counts.push('created');
                }
                if (counts.length) metaTag = ` <span class="text-zinc-600">— ${counts.join(', ')}</span>`;
              }
              summary.innerHTML = `<span class="mr-1">🔧</span> Used <strong>${data.tool_use.name}</strong>${sourcesTag}${metaTag}`;

              // Raw JSON goes inside the collapsible
              const body = document.createElement('pre');
              body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-40 overflow-y-auto slim-scrollbar';
              body.textContent = data.tool_use.result;
              detail.appendChild(summary);
              detail.appendChild(body);

              // Render _diff as color-coded diff block
              if (parsedResult?._diff) {
                const diffPre = document.createElement('pre');
                diffPre.className = 'mt-1 whitespace-pre-wrap text-xs max-h-60 overflow-y-auto slim-scrollbar';
                diffPre.innerHTML = colorizeDiff(parsedResult._diff);
                detail.appendChild(diffPre);
                body.style.display = 'none'; // hide raw JSON when diff is shown
              }

              // Render _markdown tables inside the collapsible details (user can expand to see)
              if (parsedResult?._markdown) {
                const mdDiv = document.createElement('div');
                mdDiv.className = 'mt-2 text-sm border-t border-zinc-800 pt-2';
                renderFormattedContent(parsedResult._markdown, mdDiv);
                detail.appendChild(mdDiv);
              }

              // Detect image URLs in tool results and render as collapsible thumbnails
              const imageUrls = extractImageUrls(parsedResult);
              if (imageUrls.length > 0) {
                const imgDetail = document.createElement('details');
                imgDetail.className = 'mt-2 border-t border-zinc-800 pt-2';
                const imgSummary = document.createElement('summary');
                imgSummary.className = 'text-xs text-zinc-400 cursor-pointer hover:text-zinc-300 transition-colors select-none';
                imgSummary.textContent = `📷 Photos (${imageUrls.slice(0, 12).length})`;
                imgDetail.appendChild(imgSummary);
                const imgGrid = document.createElement('div');
                imgGrid.className = 'msg-image-grid mt-2';
                for (const url of imageUrls.slice(0, 12)) {
                  const img = document.createElement('img');
                  img.src = url;
                  img.className = 'msg-image-thumb';
                  img.loading = 'lazy';
                  img.alt = '';
                  img.addEventListener('click', () => {
                    const overlay = document.createElement('div');
                    overlay.className = 'image-overlay';
                    const full = document.createElement('img');
                    full.src = url;
                    full.className = 'image-overlay-img';
                    overlay.appendChild(full);
                    overlay.addEventListener('click', () => overlay.remove());
                    document.body.appendChild(overlay);
                  });
                  img.addEventListener('error', () => img.remove());
                  imgGrid.appendChild(img);
                }
                imgDetail.appendChild(imgGrid);
                toolUseContainer.appendChild(imgDetail);
              }

              toolUseContainer.appendChild(detail);

              responseArea.scrollTop = responseArea.scrollHeight;
            } // end else (thinkEnabled)
            } // end if (data.tool_use)
            if (data.confirm_command) {
              if (!hasToolUse) {
                hasToolUse = true;
                bubble.insertBefore(toolUseContainer, contentSpan);
              }
              const confirmDiv = document.createElement('div');
              confirmDiv.className = 'my-2 p-3 bg-zinc-900 border border-zinc-700 rounded-lg text-xs';
              const cmdText = data.confirm_command.command;
              const hasDiff = cmdText.includes('\n---') || cmdText.includes('\n@@');
              const cmdHtml = hasDiff ? colorizeDiff(cmdText) : cmdText.replace(/&/g, '&amp;').replace(/</g, '&lt;');
              confirmDiv.innerHTML = `
                <div class="text-zinc-400 mb-2">${hasDiff ? 'Review changes:' : 'Run command:'}</div>
                <pre class="${hasDiff ? '' : 'text-amber-400 '}mb-2 whitespace-pre-wrap text-xs">${cmdHtml}</pre>
                <div class="flex gap-2">
                  <button class="cmd-approve px-3 py-1 rounded font-medium" style="color:#4ade80">✓ Approve</button>
                  <button class="cmd-deny px-3 py-1 rounded font-medium" style="color:#f87171">✕ Deny</button>
                </div>`;
              toolUseContainer.appendChild(confirmDiv);
              responseArea.scrollTop = responseArea.scrollHeight;

              const approveBtn = confirmDiv.querySelector('.cmd-approve');
              const denyBtn = confirmDiv.querySelector('.cmd-deny');
              const respond = async (approved) => {
                approveBtn.disabled = true;
                denyBtn.disabled = true;
                confirmDiv.querySelector('.flex').innerHTML = `<span class="${approved ? 'text-green-400' : 'text-red-400'}">${approved ? 'Approved' : 'Denied'}</span>`;
                await fetch(`/api/conversations/${state.currentConversationId}/confirm`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ approved }),
                });
              };
              approveBtn.addEventListener('click', () => respond(true));
              denyBtn.addEventListener('click', () => respond(false));
              const onEnter = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); document.removeEventListener('keydown', onEnter); respond(true); }
              };
              document.addEventListener('keydown', onEnter);
            }
            if (data.content) {
              // Collapse the "Working..." indicator when final content arrives
              if (toolUseContainer._thinkingEl) {
                const thinkDetails = toolUseContainer._thinkingEl.closest('details');
                thinkDetails.open = false;
                thinkDetails.querySelector('summary').innerHTML = '<span class="mr-1">💭</span> Thought process';
                delete toolUseContainer._thinkingEl;
              }
              if (hasReasoning && reasoningSummary.textContent !== 'Thought process') {
                reasoningSummary.textContent = 'Thought process';
                addRefineButton(reasoningDetails, () => content, () => accumulatedReasoning);
              }
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
    stopElapsedTimer();
    if (accumulated) renderFormattedContent(accumulated, contentSpan, { renderMermaid: true });
    state.abortController = null;
    sendBtn.disabled = false;
    stopBtn.classList.add('hidden');
    input.focus();
    // Re-render from server data so regen buttons appear on user messages
    try {
      const conv = await api.getConversation(state.currentConversationId);
      if (conv?.messages) renderMessages(conv.messages);
    } catch {}
    // Refresh sidebar to pick up auto-title, slots to clear active state
    refreshSidebar();
    refreshSlots();
  }
}

// ── Task processor ────────────────────────────────────
function parseTaskList(text) {
  const lines = text.split('\n');
  const tasks = [];
  let current = null;
  for (const line of lines) {
    const topMatch = line.match(/^- (.+)/);
    const subMatch = line.match(/^ {2,}- (.+)/);
    if (subMatch && current) {
      current.subtasks.push(subMatch[1].trim());
    } else if (topMatch) {
      current = { text: topMatch[1].trim(), subtasks: [] };
      tasks.push(current);
    }
  }
  // Simplify: tasks with no subtasks → just the text string
  return tasks.map(t => t.subtasks.length > 0 ? t : t.text);
}

async function sendTasks(tasks, displayText) {
  if (!state.currentConversationId) return;

  appendMessage('user', displayText);
  const bubble = appendMessage('assistant', '');
  sendBtn.disabled = true;
  stopBtn.classList.remove('hidden');
  startElapsedTimer();

  bubble.textContent = '';
  const taskSections = new Map(); // index → { header, toolContainer, contentSpan }
  let currentSection = null;

  state.abortController = new AbortController();
  _lastRenderTime = 0;
  clearTimeout(_renderTimer);

  try {
    const res = await fetch(`/api/conversations/${state.currentConversationId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks,
        applets: state.appletsEnabled,
        autorun: state.autorunEnabled,
        precision: state.precisionEnabled,
        review: state.reviewEnabled,
      }),
      signal: state.abortController.signal,
    });

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

            // ── Task lifecycle events ──
            if (data.task_start) {
              const { index, total, text, subtasks } = data.task_start;
              const section = document.createElement('div');
              section.className = 'task-section mt-3 first:mt-0';
              const header = document.createElement('div');
              header.className = 'text-xs font-medium text-indigo-400 border-b border-zinc-700 pb-1 mb-2';
              header.textContent = `Task ${index + 1}/${total}: ${text}`;
              section.appendChild(header);

              const toolContainer = document.createElement('div');
              toolContainer.className = 'tool-use-container';
              section.appendChild(toolContainer);

              const contentSpan = document.createElement('span');
              section.appendChild(contentSpan);

              bubble.appendChild(section);
              currentSection = { section, header, toolContainer, contentSpan, accumulated: '', accumulatedReasoning: '', hasReasoning: false, reasoningDetails: null, reasoningBody: null };
              taskSections.set(index, currentSection);
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.subtask_start && currentSection) {
              const { subtaskIndex, total, text } = data.subtask_start;
              const subHeader = document.createElement('div');
              subHeader.className = 'text-xs text-zinc-400 ml-3 mt-2 mb-1';
              subHeader.textContent = `  Subtask ${subtaskIndex + 1}/${total}: ${text}`;
              currentSection.section.insertBefore(subHeader, currentSection.contentSpan);
              // Reset per-subtask accumulators
              currentSection.accumulated = '';
              currentSection.accumulatedReasoning = '';
              // Create fresh content span for this subtask
              const newContentSpan = document.createElement('span');
              newContentSpan.className = 'ml-3 block';
              currentSection.section.insertBefore(newContentSpan, currentSection.contentSpan);
              currentSection.contentSpan = newContentSpan;
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.subtask_complete) {
              // Finalize subtask content rendering
              if (currentSection && currentSection.accumulated) {
                renderFormattedContent(currentSection.accumulated, currentSection.contentSpan);
              }
            }

            if (data.task_complete) {
              // Finalize task content rendering
              if (currentSection && currentSection.accumulated) {
                renderFormattedContent(currentSection.accumulated, currentSection.contentSpan);
              }
              if (currentSection?.hasReasoning && currentSection.reasoningDetails) {
                currentSection.reasoningDetails.querySelector('summary').textContent = 'Thought process';
              }
              currentSection = null;
            }

            if (data.task_review) {
              // Pause for user review — show Continue/Retry buttons + comment input
              const reviewDiv = document.createElement('div');
              reviewDiv.className = 'my-2 ml-1';
              const commentInput = document.createElement('input');
              commentInput.type = 'text';
              commentInput.placeholder = 'Add guidance for next step...';
              Object.assign(commentInput.style, {
                width: '100%', marginBottom: '6px', padding: '5px 10px',
                fontSize: '12px', background: '#27272a', color: '#e4e4e7',
                border: '1px solid #3f3f46', borderRadius: '6px', outline: 'none',
              });
              commentInput.addEventListener('focus', () => { commentInput.style.borderColor = '#6366f1'; });
              commentInput.addEventListener('blur', () => { commentInput.style.borderColor = '#3f3f46'; });
              const btnRow = document.createElement('div');
              btnRow.className = 'flex gap-2';
              const continueBtn = document.createElement('button');
              continueBtn.className = 'px-3 py-1 bg-green-600/20 text-green-400 border border-green-500/30 rounded text-xs hover:bg-green-600/30';
              continueBtn.textContent = 'Continue';
              const retryBtn = document.createElement('button');
              retryBtn.className = 'px-3 py-1 bg-amber-600/20 text-amber-400 border border-amber-500/30 rounded text-xs hover:bg-amber-600/30';
              retryBtn.textContent = 'Retry';
              btnRow.appendChild(continueBtn);
              btnRow.appendChild(retryBtn);
              reviewDiv.appendChild(commentInput);
              reviewDiv.appendChild(btnRow);
              bubble.appendChild(reviewDiv);
              responseArea.scrollTop = responseArea.scrollHeight;
              commentInput.focus();
              const respond = async (action) => {
                const comment = commentInput.value.trim();
                reviewDiv.remove();
                await fetch(`/api/conversations/${state.currentConversationId}/task-review`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action, comment: action === 'continue' ? comment : '' }),
                });
              };
              continueBtn.addEventListener('click', () => respond('continue'));
              retryBtn.addEventListener('click', () => respond('retry'));
              commentInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); respond('continue'); }
              });
            }

            if (data.task_error) {
              const errDiv = document.createElement('div');
              errDiv.className = 'text-red-400 text-sm mt-2';
              errDiv.textContent = `Error: ${data.task_error.error}`;
              if (currentSection) {
                currentSection.section.appendChild(errDiv);
              } else {
                bubble.appendChild(errDiv);
              }
            }

            // ── Standard streaming events (routed to current section) ──
            if (data.reasoning && currentSection && state.thinkEnabled) {
              if (!currentSection.hasReasoning) {
                currentSection.hasReasoning = true;
                const details = document.createElement('details');
                details.className = 'mb-2 text-zinc-500 text-xs';
                details.open = true;
                const summary = document.createElement('summary');
                summary.className = 'cursor-pointer select-none text-zinc-500 hover:text-zinc-400';
                summary.textContent = 'Thinking…';
                const body = document.createElement('pre');
                body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-60 overflow-y-auto slim-scrollbar';
                details.appendChild(summary);
                details.appendChild(body);
                currentSection.section.insertBefore(details, currentSection.toolContainer);
                currentSection.reasoningDetails = details;
                currentSection.reasoningBody = body;
              }
              currentSection.accumulatedReasoning += data.reasoning;
              currentSection.reasoningBody.textContent = currentSection.accumulatedReasoning;
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.tool_content && currentSection && state.thinkEnabled) {
              if (!currentSection.toolContainer._thinkingEl) {
                const el = document.createElement('details');
                el.className = 'mb-2 text-zinc-500 text-xs';
                el.open = true;
                el.innerHTML = '<summary class="cursor-pointer select-none text-zinc-500 hover:text-zinc-400"><span class="mr-1">⏳</span> Working...</summary>';
                const body = document.createElement('pre');
                body.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-40 overflow-y-auto slim-scrollbar';
                el.appendChild(body);
                currentSection.toolContainer.appendChild(el);
                currentSection.toolContainer._thinkingEl = body;
              }
              currentSection.toolContainer._thinkingEl.textContent += data.tool_content;
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.tool_status && currentSection && state.thinkEnabled) {
              const prev = currentSection.toolContainer.querySelector('.tool-status-msg');
              if (prev) prev.remove();
              const statusEl = document.createElement('div');
              statusEl.className = 'tool-status-msg text-xs text-indigo-400 py-1 animate-pulse';
              statusEl.textContent = data.tool_status;
              currentSection.toolContainer.appendChild(statusEl);
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.tool_use && currentSection) {
              // Clean up thinking element
              if (currentSection.toolContainer._thinkingEl) {
                const thinkDetails = currentSection.toolContainer._thinkingEl.closest('details');
                thinkDetails.open = false;
                thinkDetails.querySelector('summary').innerHTML = '<span class="mr-1">💭</span> Thought process';
                delete currentSection.toolContainer._thinkingEl;
              }
              // Remove status messages
              currentSection.toolContainer.querySelectorAll('.tool-status-msg').forEach(el => el.remove());

              if (state.thinkEnabled) {
                const detail = document.createElement('details');
                detail.className = 'mb-1 text-zinc-500 text-xs';
                const summary = document.createElement('summary');
                summary.className = 'cursor-pointer select-none text-zinc-500 hover:text-zinc-400';
                summary.textContent = `Used ${data.tool_use.name}`;
                detail.appendChild(summary);
                const pre = document.createElement('pre');
                pre.className = 'mt-1 whitespace-pre-wrap text-zinc-600 max-h-40 overflow-y-auto slim-scrollbar';
                try {
                  const parsed = JSON.parse(data.tool_use.result);
                  if (parsed._diff) {
                    pre.innerHTML = colorizeDiff(parsed._diff);
                  } else if (parsed._markdown) {
                    pre.textContent = parsed._markdown.slice(0, 2000);
                  } else {
                    pre.textContent = JSON.stringify(parsed, null, 2).slice(0, 2000);
                  }
                } catch {
                  pre.textContent = String(data.tool_use.result).slice(0, 2000);
                }
                detail.appendChild(pre);
                currentSection.toolContainer.appendChild(detail);
              }
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.confirm_command && currentSection) {
              const confirmDiv = document.createElement('div');
              confirmDiv.className = 'my-2 p-2 bg-zinc-800 border border-amber-500/30 rounded-lg text-sm';
              confirmDiv.innerHTML = `<div class="text-amber-400 text-xs mb-1">Confirm command:</div><pre class="text-zinc-300 text-xs whitespace-pre-wrap mb-2">${data.confirm_command.command}</pre>`;
              const btnRow = document.createElement('div');
              btnRow.className = 'flex gap-2';
              const approveBtn = document.createElement('button');
              approveBtn.className = 'px-3 py-1 bg-green-600/20 text-green-400 border border-green-500/30 rounded text-xs hover:bg-green-600/30';
              approveBtn.textContent = 'Approve';
              const denyBtn = document.createElement('button');
              denyBtn.className = 'px-3 py-1 bg-red-600/20 text-red-400 border border-red-500/30 rounded text-xs hover:bg-red-600/30';
              denyBtn.textContent = 'Deny';
              btnRow.appendChild(approveBtn);
              btnRow.appendChild(denyBtn);
              confirmDiv.appendChild(btnRow);
              currentSection.section.insertBefore(confirmDiv, currentSection.contentSpan);
              const respond = async (approved) => {
                await fetch(`/api/conversations/${state.currentConversationId}/confirm`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ approved }),
                });
                confirmDiv.remove();
              };
              approveBtn.addEventListener('click', () => respond(true));
              denyBtn.addEventListener('click', () => respond(false));
            }

            if (data.content && currentSection) {
              // Clean up thinking element on first content
              if (currentSection.toolContainer._thinkingEl) {
                const thinkDetails = currentSection.toolContainer._thinkingEl.closest('details');
                thinkDetails.open = false;
                thinkDetails.querySelector('summary').innerHTML = '<span class="mr-1">💭</span> Thought process';
                delete currentSection.toolContainer._thinkingEl;
              }
              currentSection.accumulated += data.content;
              scheduleRender(currentSection.accumulated, currentSection.contentSpan);
              responseArea.scrollTop = responseArea.scrollHeight;
            }

            if (data.usage) {
              const total = data.usage.total_tokens || (data.usage.prompt_tokens + data.usage.completion_tokens) || 0;
              updateContextBar(total);
            }

            if (data.error) {
              const errDiv = document.createElement('div');
              errDiv.className = 'text-red-400 text-sm mt-2';
              errDiv.textContent = `Error: ${data.error}`;
              bubble.appendChild(errDiv);
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
    stopElapsedTimer();
    // Final render pass for any remaining section
    for (const [, sec] of taskSections) {
      if (sec.accumulated) renderFormattedContent(sec.accumulated, sec.contentSpan, { renderMermaid: true });
    }
    state.abortController = null;
    sendBtn.disabled = false;
    stopBtn.classList.add('hidden');
    input.focus();
    try {
      const conv = await api.getConversation(state.currentConversationId);
      if (conv?.messages) renderMessages(conv.messages);
    } catch {}
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
let llmBackends = [];

async function pollLLM() {
  try {
    const res = await fetch('/api/health/llm');
    const { ok, backend, backends } = await res.json();
    state.healthy = ok;
    llmDot.className = `inline-block w-2 h-2 rounded-full ${ok ? 'bg-green-500 pulse-dot' : 'bg-red-500'}`;
    llmLabel.textContent = backend || 'LLM';
    llmToggle.className = `flex items-center gap-1 transition-colors ${ok ? 'text-green-500 hover:text-green-400' : 'text-red-400 hover:text-red-300'}`;
    if (backends) llmBackends = backends;
  } catch {
    state.healthy = false;
    llmDot.className = 'inline-block w-2 h-2 rounded-full bg-red-500';
    llmLabel.textContent = 'LLM';
    llmToggle.className = 'flex items-center gap-1 transition-colors text-red-400 hover:text-red-300';
  }
}

function renderLLMDropdown() {
  llmDropdown.innerHTML = '';
  for (const b of llmBackends) {
    const item = document.createElement('button');
    item.className = `w-full text-left px-3 py-1.5 text-xs transition-colors ${
      b.active
        ? 'text-indigo-400 bg-indigo-500/10'
        : b.configured
          ? 'text-zinc-300 hover:bg-zinc-700'
          : 'text-zinc-600 cursor-not-allowed'
    }`;
    item.textContent = b.label + (b.active ? ' \u2713' : !b.configured ? ' (no key)' : '');
    if (!b.active && b.configured) {
      item.addEventListener('click', () => switchLLMBackend(b.id));
    }
    llmDropdown.appendChild(item);
  }
}

async function switchLLMBackend(backendId) {
  llmDropdown.classList.add('hidden');
  llmDot.className = 'inline-block w-2 h-2 rounded-full bg-zinc-600 animate-pulse';
  llmLabel.textContent = 'Switching\u2026';
  llmToggle.className = 'flex items-center gap-1 transition-colors text-zinc-500';
  try {
    await fetch('/api/health/llm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: backendId }),
    });
  } catch { /* pollLLM will pick up the state */ }
  await pollLLM();
}

llmToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const isOpen = !llmDropdown.classList.contains('hidden');
  llmDropdown.classList.toggle('hidden');
  if (!isOpen) renderLLMDropdown();
});

llmDropdown.addEventListener('click', (e) => e.stopPropagation());

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
  llmDropdown.classList.add('hidden');
  // Close all dynamic plugin panels
  Object.values(pluginElements).forEach(el => { if (el.panel) el.panel.classList.add('hidden'); });
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

// ── Plugin status system (dynamic dots + generic auth) ──
const pluginElements = {};  // group → { wrapper, dot, toggle, panel, panelContent }
const pluginIntervals = []; // interval IDs for cleanup

function updatePluginDot(group, state) {
  const el = pluginElements[group];
  if (!el) return;
  const colors = {
    ok:     { dot: 'bg-green-500 pulse-dot', text: 'text-green-500' },
    unauth: { dot: 'bg-amber-500',           text: 'text-amber-500 hover:text-amber-400 transition-colors' },
    error:  { dot: 'bg-red-500',             text: 'text-red-400' },
  };
  const c = colors[state] || colors.error;
  el.dot.className = `inline-block w-2 h-2 rounded-full ${c.dot}`;
  el.toggle.className = c.text;
  el.toggle.textContent = el.label;
}

function renderPluginAuthPanel(group, panelContent, state) {
  if (state === 'ok') {
    panelContent.innerHTML = `
      <div class="text-xs text-green-400 mb-1">Connected</div>
      <button class="plugin-disconnect-btn w-full bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-xs font-medium px-3 py-1.5 rounded transition-colors">
        Disconnect &amp; Reconnect
      </button>`;
    panelContent.querySelector('.plugin-disconnect-btn').addEventListener('click', async () => {
      await fetch(`/api/plugins/${group}/auth/disconnect`, { method: 'POST' });
      await pollPluginStatuses();
    });
    return;
  }
  panelContent.innerHTML = `
    <div class="plugin-auth-step1">
      <div class="text-xs text-zinc-400 mb-2">Connect your account (read-only)</div>
      <button class="plugin-auth-btn w-full bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors">
        Open Authorization
      </button>
    </div>
    <div class="plugin-auth-step2 hidden mt-2">
      <div class="text-xs text-zinc-400 mb-2">Paste the verifier code:</div>
      <div class="flex gap-2">
        <input class="plugin-auth-input flex-1 bg-zinc-900 text-zinc-100 text-xs px-2 py-1.5 rounded border border-zinc-600 outline-none focus:border-zinc-400" type="text" placeholder="Verifier code">
        <button class="plugin-auth-submit bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1.5 rounded transition-colors">
          Connect
        </button>
      </div>
      <div class="plugin-auth-error text-red-400 text-xs mt-1 hidden"></div>
    </div>`;

  panelContent.querySelector('.plugin-auth-btn').addEventListener('click', async () => {
    const btn = panelContent.querySelector('.plugin-auth-btn');
    btn.textContent = 'Opening…';
    btn.disabled = true;
    try {
      const res = await fetch(`/api/plugins/${group}/auth/start`, { method: 'POST' });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.url) window.open(data.url, '_blank');
      panelContent.querySelector('.plugin-auth-step2').classList.remove('hidden');
      btn.textContent = data.url ? 'Opened — paste code below' : (data.message || 'Enter code below');
    } catch (err) {
      btn.textContent = 'Failed — try again';
      btn.disabled = false;
    }
  });

  panelContent.querySelector('.plugin-auth-submit').addEventListener('click', async () => {
    const input = panelContent.querySelector('.plugin-auth-input').value.trim();
    const errEl = panelContent.querySelector('.plugin-auth-error');
    if (!input) return;
    errEl.classList.add('hidden');
    try {
      const res = await fetch(`/api/plugins/${group}/auth/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const el = pluginElements[group];
      if (el?.panel) el.panel.classList.add('hidden');
      await pollPluginStatuses();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  });
}

function createPluginStatusElement(plugin) {
  const wrapper = document.createElement('div');
  wrapper.className = 'relative flex items-center gap-2';

  const dot = document.createElement('span');
  dot.className = 'inline-block w-2 h-2 rounded-full bg-zinc-600';

  const toggle = document.createElement('button');
  toggle.className = 'text-zinc-500 hover:text-zinc-300 transition-colors';
  toggle.textContent = plugin.label;

  wrapper.appendChild(dot);
  wrapper.appendChild(toggle);

  let panel = null, panelContent = null;
  if (plugin.hasAuth) {
    panel = document.createElement('div');
    panel.className = 'hidden absolute top-full left-0 mt-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-lg p-3 z-50 min-w-[260px]';
    panelContent = document.createElement('div');
    panel.appendChild(panelContent);
    wrapper.appendChild(panel);
    panel.addEventListener('click', (e) => e.stopPropagation());

    toggle.addEventListener('click', async (e) => {
      e.stopPropagation();
      const isOpen = !panel.classList.contains('hidden');
      // close all other plugin panels
      Object.values(pluginElements).forEach(el => { if (el.panel) el.panel.classList.add('hidden'); });
      if (!isOpen) {
        panel.classList.remove('hidden');
        const statuses = await (await fetch('/api/plugins/status')).json();
        const s = statuses.find(p => p.group === plugin.group);
        renderPluginAuthPanel(plugin.group, panelContent, s?.state);
      }
    });
  }

  pluginElements[plugin.group] = {
    wrapper, dot, toggle, panel, panelContent,
    label: plugin.label, hasAuth: plugin.hasAuth,
  };

  return wrapper;
}

async function pollPluginStatuses() {
  try {
    const statuses = await (await fetch('/api/plugins/status')).json();
    // Handle managed: false plugins (show/hide hardcoded elements)
    const webPlugin = statuses.find(p => p.group === 'web');
    if (searchStatus) {
      searchStatus.style.display = webPlugin ? '' : 'none';
    }
    // Handle managed: true plugins
    for (const plugin of statuses) {
      if (!plugin.managed) continue;
      if (plugin.state === null) {
        // hidden — remove element if it exists
        if (pluginElements[plugin.group]) {
          pluginElements[plugin.group].wrapper.remove();
          delete pluginElements[plugin.group];
        }
        continue;
      }
      // create element if first time
      if (!pluginElements[plugin.group]) {
        const el = createPluginStatusElement(plugin);
        pluginStatusContainer.appendChild(el);
      }
      updatePluginDot(plugin.group, plugin.state);
    }
    // Remove elements for plugins no longer in response
    const activeGroups = new Set(statuses.filter(p => p.managed && p.state !== null).map(p => p.group));
    for (const group of Object.keys(pluginElements)) {
      if (!activeGroups.has(group)) {
        pluginElements[group].wrapper.remove();
        delete pluginElements[group];
      }
    }
  } catch {}
}

async function initPluginStatuses() {
  await pollPluginStatuses();
  // Set up per-plugin polling based on intervals
  try {
    const statuses = await (await fetch('/api/plugins/status')).json();
    const intervals = new Set();
    for (const p of statuses) {
      if (p.managed && p.interval > 0) intervals.add(p.interval);
    }
    for (const ms of intervals) {
      pluginIntervals.push(setInterval(pollPluginStatuses, ms));
    }
  } catch {}
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

// ── Session color helpers ─────────────────────────────
function applySessionColor(type) {
  state.sessionType = type;
  // Persist color for current conversation
  if (state.currentConversationId && type) {
    state.sessionColors[state.currentConversationId] = type;
    localStorage.setItem('sessionColors', JSON.stringify(state.sessionColors));
  }
  const color = type ? getComputedStyle(document.documentElement).getPropertyValue(`--btn-${type}`).trim() : '';
  input.style.borderColor = color || '';
  updateInputLock();
  renderSidebar();
}

function persistActiveConversation() {
  if (state.currentConversationId) {
    localStorage.setItem('activeConversationId', state.currentConversationId);
  } else {
    localStorage.removeItem('activeConversationId');
  }
}

function updateInputLock() {
  const locked = !state.currentConversationId || !state.sessionType;
  input.disabled = locked;
  sendBtn.disabled = locked;
  input.placeholder = locked ? 'Select or create a session to start…' : 'Type your message…';
}

// ── Event handlers ────────────────────────────────────
newChatButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    const sessionType = btn.dataset.session;
    const conv = await api.createConversation();
    state.currentConversationId = conv.id;
    persistActiveConversation();
    applySessionColor(sessionType);
    await refreshSidebar();
    renderMessages([]);
    updateContextBar(0);

    // Auto-load and submit saved session prompt for this color
    try {
      const sessions = await (await fetch('/api/sessions')).json();
      const match = sessions.find(s => s.color === sessionType);
      if (match) {
        const vars = extractPromptVariables(match.text);
        // Disable Think for session init prompt
        const wasThinkEnabled = state.thinkEnabled;
        state.thinkEnabled = false;
        thinkToggle.checked = false;
        if (vars.length > 0) {
          showPromptVarsModal(match.text, vars);
          const modal = document.getElementById('prompt-vars-modal');
          modal._restoreThink = wasThinkEnabled;
        } else {
          const text = expandPromptMacros(match.text);
          await sendMessage(text, null, { sessionInit: true });
          state.thinkEnabled = wasThinkEnabled;
          thinkToggle.checked = wasThinkEnabled;
          return;
        }
      }
    } catch {}

    input.focus();
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  // Must have an active session to send
  if (!requireSession()) return;
  const content = input.value.trim();
  const images = state.pendingImages.length > 0 ? [...state.pendingImages] : null;
  if (!content && !images) return;
  input.value = '';
  input.style.height = 'auto';
  clearPendingImages();
  // List mode: parse bullets into structured tasks and run task processor
  if (state.listMode) {
    const tasks = parseTaskList(content);
    if (tasks.length > 0) {
      toggleListMode(false);
      await sendTasks(tasks, content);
      return;
    }
  }
  await sendMessage(content, images);
});

// Auto-resize textarea + list mode auto-detection
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  if (state.listMode) {
    // Exit list mode if textarea no longer has any bullets
    if (!input.value.includes('- ')) toggleListMode(false);
  } else {
    // Auto-activate list mode if content looks like a bullet list (e.g. pasted)
    const lines = input.value.trimStart().split('\n');
    if (lines.length >= 2 && lines[0].startsWith('- ') && lines.filter(l => l.match(/^( {2,})?- /)).length === lines.filter(l => l.trim()).length) {
      toggleListMode(true);
    }
  }
});

// Ctrl+Enter / Cmd+Enter to submit
input.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    form.requestSubmit();
    return;
  }

  // ── List mode keyboard handling ──
  if (state.listMode) {
    const pos = input.selectionStart;
    const val = input.value;
    const beforeCursor = val.slice(0, pos);
    const lastNewline = beforeCursor.lastIndexOf('\n');
    const lineStart = lastNewline + 1;
    const linePrefix = val.slice(lineStart, pos);
    // Detect current indent: count leading spaces before "- "
    const indentMatch = val.slice(lineStart).match(/^( *)-/);
    const currentIndent = indentMatch ? indentMatch[1] : '';

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // New bullet at same indent level
      input.value = val.slice(0, pos) + '\n' + currentIndent + '- ' + val.slice(pos);
      const newPos = pos + 1 + currentIndent.length + 2;
      input.selectionStart = input.selectionEnd = newPos;
      input.dispatchEvent(new Event('input'));
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      // Indent: add 2 spaces at line start (only allow 1 level = 2 spaces)
      if (currentIndent.length < 2 && lineStart > 0) {
        input.value = val.slice(0, lineStart) + '  ' + val.slice(lineStart);
        input.selectionStart = input.selectionEnd = pos + 2;
        input.dispatchEvent(new Event('input'));
      }
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      // Outdent: remove 2 leading spaces
      if (currentIndent.length >= 2) {
        input.value = val.slice(0, lineStart) + val.slice(lineStart + 2);
        input.selectionStart = input.selectionEnd = pos - 2;
        input.dispatchEvent(new Event('input'));
      }
    } else if (e.key === 'Backspace') {
      // Indented empty bullet "  - " → outdent to "- " first
      if (linePrefix.match(/^ +- $/)) {
        e.preventDefault();
        if (currentIndent.length >= 2) {
          // Outdent
          input.value = val.slice(0, lineStart) + val.slice(lineStart + 2);
          input.selectionStart = input.selectionEnd = pos - 2;
        } else if (lineStart === 0) {
          // First line top-level empty bullet — exit list mode
          input.value = val.slice(pos);
          input.selectionStart = input.selectionEnd = 0;
          toggleListMode(false);
        } else {
          // Remove "\n- "
          input.value = val.slice(0, lineStart - 1) + val.slice(pos);
          input.selectionStart = input.selectionEnd = lineStart - 1;
        }
        input.dispatchEvent(new Event('input'));
      }
    }
  }
});

// ── List mode ─────────────────────────────────────────
function toggleListMode(force) {
  state.listMode = typeof force === 'boolean' ? force : !state.listMode;
  listModeBtn.classList.toggle('text-indigo-400', state.listMode);
  listModeBtn.classList.toggle('text-zinc-500', !state.listMode);
  reviewToggleLabel.classList.toggle('hidden', !state.listMode);
  updateListModeSaveButtons();
  if (state.listMode) {
    // Prefix first bullet if textarea is empty or doesn't start with "- "
    if (!input.value.startsWith('- ')) {
      const prev = input.value;
      input.value = '- ' + prev;
      input.selectionStart = input.selectionEnd = input.value.length;
    }
    input.focus();
  }
}

function updateListModeSaveButtons() {
  const disabled = state.listMode;
  saveSessionBtn.disabled = disabled;
  saveCompactBtn.disabled = disabled;
  saveSessionBtn.style.opacity = disabled ? '0.3' : '';
  saveCompactBtn.style.opacity = disabled ? '0.3' : '';
}

listModeBtn.addEventListener('click', () => toggleListMode());

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

// Applet toggle
appletToggle.checked = state.appletsEnabled;
appletToggle.addEventListener('change', () => {
  state.appletsEnabled = appletToggle.checked;
  localStorage.setItem('appletsEnabled', state.appletsEnabled);
});

// Autorun toggle
autorunToggle.checked = state.autorunEnabled;
autorunToggle.addEventListener('change', () => {
  state.autorunEnabled = autorunToggle.checked;
  localStorage.setItem('autorunEnabled', state.autorunEnabled);
});

// Think toggle
thinkToggle.checked = state.thinkEnabled;
thinkToggle.addEventListener('change', () => {
  state.thinkEnabled = thinkToggle.checked;
  localStorage.setItem('thinkEnabled', state.thinkEnabled);
});

// Review toggle (visible only in list mode)
reviewToggle.checked = state.reviewEnabled;
reviewToggle.addEventListener('change', () => {
  state.reviewEnabled = reviewToggle.checked;
  localStorage.setItem('reviewEnabled', state.reviewEnabled);
});

// Precision toggle
precisionToggle.checked = state.precisionEnabled;
precisionToggle.addEventListener('change', () => {
  state.precisionEnabled = precisionToggle.checked;
  localStorage.setItem('precisionEnabled', state.precisionEnabled);
});

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
  templatesDropdown.classList.add('hidden');
  sessionsDropdown.classList.add('hidden');
  compactsDropdown.classList.add('hidden');
  tasksDropdown.classList.add('hidden');
  promptsDropdown.classList.toggle('hidden');
});
promptsDropdown.addEventListener('click', (e) => e.stopPropagation());

// ── Templates dropdown ──────────────────────────────────
templatesToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  promptsDropdown.classList.add('hidden');

  sessionsDropdown.classList.add('hidden');
  compactsDropdown.classList.add('hidden');
  tasksDropdown.classList.add('hidden');
  templatesDropdown.classList.toggle('hidden');
  if (!templatesDropdown.classList.contains('hidden')) refreshTemplates();
});
templatesDropdown.addEventListener('click', (e) => e.stopPropagation());

// ── Sessions dropdown ──────────────────────────────────
sessionsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  promptsDropdown.classList.add('hidden');

  templatesDropdown.classList.add('hidden');
  compactsDropdown.classList.add('hidden');
  tasksDropdown.classList.add('hidden');
  sessionsDropdown.classList.toggle('hidden');
  if (!sessionsDropdown.classList.contains('hidden')) refreshSessions();
});
sessionsDropdown.addEventListener('click', (e) => e.stopPropagation());

// ── Compacts dropdown ──────────────────────────────────
compactsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  promptsDropdown.classList.add('hidden');

  sessionsDropdown.classList.add('hidden');
  templatesDropdown.classList.add('hidden');
  tasksDropdown.classList.add('hidden');
  compactsDropdown.classList.toggle('hidden');
  if (!compactsDropdown.classList.contains('hidden')) refreshCompacts();
});
compactsDropdown.addEventListener('click', (e) => e.stopPropagation());

// ── Tasks dropdown ──────────────────────────────────
tasksToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  promptsDropdown.classList.add('hidden');

  sessionsDropdown.classList.add('hidden');
  compactsDropdown.classList.add('hidden');
  templatesDropdown.classList.add('hidden');
  tasksDropdown.classList.toggle('hidden');
  if (!tasksDropdown.classList.contains('hidden')) refreshTasks();
});
tasksDropdown.addEventListener('click', (e) => e.stopPropagation());

function renderCompacts(compacts) {
  compactList.innerHTML = '';
  if (!compacts.length) {
    compactList.innerHTML = '<div class="px-3 py-2 text-xs text-zinc-500">No compact prompts saved yet</div>';
    return;
  }
  let dragSrcEl = null;

  for (const c of compacts) {
    const item = document.createElement('div');
    item.className = 'group flex items-center gap-1 px-3 py-2 cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors';
    item.dataset.id = c.id;

    const grip = document.createElement('span');
    grip.className = 'cursor-grab text-zinc-600 hover:text-zinc-400 text-xs select-none shrink-0';
    grip.textContent = '⠿';
    grip.addEventListener('mousedown', () => { item.draggable = true; });
    grip.addEventListener('mouseup', () => { item.draggable = false; });

    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      item.draggable = false;
      dragSrcEl = null;
      compactList.querySelectorAll('[data-id]').forEach(el => el.classList.remove('border-t-indigo-500'));
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
      compactList.insertBefore(dragSrcEl, item);
      const ids = [...compactList.querySelectorAll('[data-id]')].map(el => el.dataset.id);
      await fetch('/api/compacts/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'flex-1 text-xs';
    titleSpan.textContent = c.title || c.text.slice(0, 60);
    const cssVar = getComputedStyle(document.documentElement).getPropertyValue(`--btn-${c.color}`).trim();
    if (cssVar) titleSpan.style.color = textSafeColor(cssVar);

    const editBtn = document.createElement('button');
    editBtn.className = 'text-zinc-600 hover:text-zinc-300 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startTitleEdit(titleSpan, async (newTitle) => {
        await fetch(`/api/compacts/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
      });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/compacts/${c.id}`, { method: 'DELETE' });
      refreshCompacts();
    });

    item.addEventListener('click', () => {
      compactsDropdown.classList.add('hidden');
      if (!requireSession()) return;
      input.value = c.text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      input.focus();
    });

    item.appendChild(grip);
    item.appendChild(titleSpan);
    item.appendChild(editBtn);
    item.appendChild(delBtn);
    compactList.appendChild(item);
  }
}

async function refreshCompacts() {
  try {
    const compacts = await (await fetch('/api/compacts')).json();
    state.compactColors = new Set(compacts.map(c => c.color));
    renderCompacts(compacts);
  } catch {}
}

function startTitleEdit(titleSpan, onSave) {
  const orig = titleSpan.textContent;
  titleSpan.contentEditable = 'true';
  titleSpan.classList.add('bg-zinc-800', 'rounded', 'px-1', 'outline-none', 'ring-1', 'ring-zinc-600');
  titleSpan.focus();
  const range = document.createRange();
  range.selectNodeContents(titleSpan);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);

  const stopClick = (e) => e.stopPropagation();
  const finish = (save) => {
    titleSpan.contentEditable = 'false';
    titleSpan.classList.remove('bg-zinc-800', 'rounded', 'px-1', 'outline-none', 'ring-1', 'ring-zinc-600');
    titleSpan.removeEventListener('click', stopClick);
    const newTitle = titleSpan.textContent.trim();
    if (save && newTitle && newTitle !== orig) {
      onSave(newTitle);
    } else {
      titleSpan.textContent = orig;
    }
  };
  titleSpan.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  titleSpan.addEventListener('blur', () => finish(true), { once: true });
  titleSpan.addEventListener('click', stopClick);
}

function renderSessions(sessions) {
  sessionList.innerHTML = '';
  let dragSrcEl = null;

  for (const s of sessions) {
    const item = document.createElement('div');
    item.className = 'group flex items-center gap-1 px-3 py-2 cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors';
    item.dataset.id = s.id;

    const grip = document.createElement('span');
    grip.className = 'cursor-grab text-zinc-600 hover:text-zinc-400 text-xs select-none shrink-0';
    grip.textContent = '⠿';
    grip.addEventListener('mousedown', () => { item.draggable = true; });
    grip.addEventListener('mouseup', () => { item.draggable = false; });

    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      item.draggable = false;
      dragSrcEl = null;
      sessionList.querySelectorAll('[data-id]').forEach(el => el.classList.remove('border-t-indigo-500'));
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
      sessionList.insertBefore(dragSrcEl, item);
      const ids = [...sessionList.querySelectorAll('[data-id]')].map(el => el.dataset.id);
      await fetch('/api/sessions/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'flex-1 text-xs';
    titleSpan.textContent = s.title || s.text.slice(0, 60);
    const cssVar = getComputedStyle(document.documentElement).getPropertyValue(`--btn-${s.color}`).trim();
    if (cssVar) titleSpan.style.color = textSafeColor(cssVar);

    const editBtn = document.createElement('button');
    editBtn.className = 'text-zinc-600 hover:text-zinc-300 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startTitleEdit(titleSpan, async (newTitle) => {
        await fetch(`/api/sessions/${s.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
      });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
      refreshSessions();
    });

    item.addEventListener('click', () => {
      sessionsDropdown.classList.add('hidden');
      if (!requireSession()) return;
      const vars = extractPromptVariables(s.text);
      if (vars.length > 0) {
        showPromptVarsModal(s.text, vars);
      } else {
        input.value = expandPromptMacros(s.text);
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        input.focus();
      }
    });

    item.appendChild(grip);
    item.appendChild(titleSpan);
    item.appendChild(editBtn);
    item.appendChild(delBtn);
    sessionList.appendChild(item);
  }
}

async function refreshSessions() {
  try {
    const sessions = await (await fetch('/api/sessions')).json();
    renderSessions(sessions);
    // Update session button tooltips
    for (const btn of newChatButtons) {
      const color = btn.dataset.session;
      const match = sessions.find(s => s.color === color);
      if (match) {
        btn.dataset.tip = match.title || match.text.slice(0, 60);
      } else {
        delete btn.dataset.tip;
      }
    }
  } catch {}
}

function renderTemplates(templates) {
  templateList.innerHTML = '';
  if (!templates.length) {
    templateList.innerHTML = '<div class="px-3 py-2 text-xs text-zinc-500">No templates saved yet</div>';
    return;
  }
  let dragSrcEl = null;

  for (const t of templates) {
    const item = document.createElement('div');
    item.className = 'group flex items-center gap-1 px-3 py-2 cursor-pointer border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors';
    item.dataset.id = t.id;

    const grip = document.createElement('span');
    grip.className = 'cursor-grab text-zinc-600 hover:text-zinc-400 text-xs select-none shrink-0';
    grip.textContent = '⠿';
    grip.addEventListener('mousedown', () => { item.draggable = true; });
    grip.addEventListener('mouseup', () => { item.draggable = false; });

    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      item.draggable = false;
      dragSrcEl = null;
      templateList.querySelectorAll('[data-id]').forEach(el => el.classList.remove('border-t-indigo-500'));
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
      templateList.insertBefore(dragSrcEl, item);
      const ids = [...templateList.querySelectorAll('[data-id]')].map(el => el.dataset.id);
      await fetch('/api/templates/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    });

    const nameSpan = document.createElement('span');
    nameSpan.className = 'flex-1 text-xs text-zinc-300';
    nameSpan.textContent = t.name;

    const typeSpan = document.createElement('span');
    typeSpan.className = 'text-zinc-600 text-xs shrink-0';
    typeSpan.textContent = t.type;

    const editBtn = document.createElement('button');
    editBtn.className = 'text-zinc-600 hover:text-zinc-300 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startTitleEdit(nameSpan, async (newName) => {
        await fetch(`/api/templates/${t.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
      });
    });

    const optBtn = document.createElement('button');
    optBtn.className = 'text-zinc-600 hover:text-amber-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    optBtn.textContent = '\u26A1';
    optBtn.title = 'Optimize template with LLM';
    optBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      optBtn.textContent = '\u23F3';
      optBtn.classList.add('animate-pulse');
      try {
        const res = await fetch(`/api/templates/${t.id}/optimize`, { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
          optBtn.textContent = '\u2713';
          optBtn.classList.remove('animate-pulse');
          optBtn.className = 'text-emerald-400 text-xs px-1 shrink-0';
          optBtn.disabled = true;
        } else {
          optBtn.textContent = '\u26A1';
          optBtn.classList.remove('animate-pulse');
          console.error('Optimize failed:', data.error);
        }
      } catch {
        optBtn.textContent = '\u26A1';
        optBtn.classList.remove('animate-pulse');
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '\u2715';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/templates/${t.id}`, { method: 'DELETE' });
      refreshTemplates();
    });

    item.addEventListener('click', () => {
      if (!requireSession()) return;
      const tag = `[template: ${t.name}]`;
      const pos = input.selectionStart || input.value.length;
      input.value = input.value.slice(0, pos) + tag + input.value.slice(pos);
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      input.focus();
      templatesDropdown.classList.add('hidden');
    });

    item.appendChild(grip);
    item.appendChild(nameSpan);
    item.appendChild(typeSpan);
    item.appendChild(editBtn);
    item.appendChild(optBtn);
    item.appendChild(delBtn);
    templateList.appendChild(item);
  }
}

async function refreshTemplates() {
  try {
    const templates = await (await fetch('/api/templates')).json();
    renderTemplates(templates);
  } catch {}
}

document.addEventListener('click', (e) => {
  if (e.target !== promptsToggle) promptsDropdown.classList.add('hidden');
  if (e.target !== templatesToggle) templatesDropdown.classList.add('hidden');
  if (e.target !== sessionsToggle) sessionsDropdown.classList.add('hidden');
  if (e.target !== compactsToggle) compactsDropdown.classList.add('hidden');
  if (e.target !== tasksToggle) tasksDropdown.classList.add('hidden');
});

// ── Plugin Config Panel ─────────────────────────────
pluginsToggle.addEventListener('click', (e) => {
  e.stopPropagation();
  const showing = !pluginConfigPanel.classList.contains('hidden');
  // Close other dropdowns

  promptsDropdown.classList.add('hidden');
  sessionsDropdown.classList.add('hidden');
  compactsDropdown.classList.add('hidden');
  tasksDropdown.classList.add('hidden');
  templatesDropdown.classList.add('hidden');
  if (showing) {
    pluginConfigPanel.classList.add('hidden');
  } else {
    pluginConfigPanel.classList.remove('hidden');
    refreshPluginConfig();
  }
});

pluginConfigClose.addEventListener('click', () => {
  pluginConfigPanel.classList.add('hidden');
});

async function refreshPluginConfig() {
  try {
    const plugins = await (await fetch('/api/plugins')).json();
    renderPluginConfig(plugins);
  } catch {}
}

function renderPluginConfig(plugins) {
  pluginConfigList.innerHTML = '';
  if (plugins.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'text-zinc-500 text-sm text-center py-8';
    empty.textContent = 'No configurable plugins found.';
    pluginConfigList.appendChild(empty);
    return;
  }
  for (const p of plugins) {
    const card = document.createElement('div');
    card.className = 'flex items-center justify-between p-4 bg-zinc-800/80 border border-zinc-700/50 rounded-xl transition-colors';

    const info = document.createElement('div');
    info.className = 'flex flex-col gap-1 min-w-0';

    const label = document.createElement('span');
    label.className = 'text-sm font-medium truncate';
    label.style.color = p.enabled ? '#e4e4e7' : '#71717a';
    label.textContent = p.label;

    const desc = document.createElement('span');
    desc.className = 'text-xs';
    desc.style.color = '#a1a1aa';
    desc.textContent = p.description;

    info.appendChild(label);
    if (p.description) info.appendChild(desc);

    // Tool list
    const toolList = document.createElement('div');
    Object.assign(toolList.style, { marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' });
    for (const t of p.tools) {
      const chip = document.createElement('span');
      Object.assign(chip.style, {
        fontSize: '11px', padding: '2px 8px', borderRadius: '4px',
        background: p.enabled ? '#27272a' : '#1c1c1e',
        color: p.enabled ? '#a1a1aa' : '#52525b',
        cursor: 'default',
      });
      chip.textContent = t.name;
      chip.title = t.description;
      toolList.appendChild(chip);
    }
    info.appendChild(toolList);

    // Slider switch
    const toggle = document.createElement('button');
    Object.assign(toggle.style, {
      width: '44px', height: '24px', borderRadius: '9999px', position: 'relative',
      flexShrink: '0', transition: 'background 0.2s', cursor: 'pointer', border: 'none',
      background: p.enabled ? '#6366f1' : '#3f3f46', marginLeft: '16px',
    });
    const knob = document.createElement('span');
    Object.assign(knob.style, {
      position: 'absolute', top: '3px', width: '18px', height: '18px',
      borderRadius: '9999px', background: 'white', transition: 'left 0.2s',
      left: p.enabled ? '22px' : '3px',
    });
    toggle.appendChild(knob);

    toggle.addEventListener('click', async () => {
      toggle.style.opacity = '0.5';
      toggle.style.pointerEvents = 'none';
      try {
        const res = await fetch(`/api/plugins/${p.group}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !p.enabled }),
        });
        if (res.ok) {
          refreshPluginConfig();
          pollPluginStatuses();
        }
      } finally {
        toggle.style.opacity = '1';
        toggle.style.pointerEvents = 'auto';
      }
    });

    card.appendChild(info);
    card.appendChild(toggle);
    pluginConfigList.appendChild(card);
  }
}


function expandPromptMacros(text) {
  const now = new Date();
  return text
    .replace(/\{\$date\}/gi, now.toLocaleDateString('en-CA'))
    .replace(/\{\$time\}/gi, now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }))
    .replace(/\{\$year\}/gi, String(now.getFullYear()))
    .replace(/\{\$month\}/gi, now.toLocaleDateString('en-US', { month: 'long' }))
    .replace(/\{\$day\}/gi, now.toLocaleDateString('en-US', { weekday: 'long' }))
    .replace(/\{\$location\}/gi, state.location);
}

// ── Prompt Variables ─────────────────────────────────
const builtinMacros = new Set(['date', 'time', 'year', 'month', 'day', 'location']);

function extractPromptVariables(text) {
  const vars = [];
  const seen = new Set();
  const re = /\{\$(\w+)(?::(\w+))?\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (builtinMacros.has(name.toLowerCase()) || seen.has(name)) continue;
    seen.add(name);
    const type = (m[2] || 'string').toLowerCase();
    vars.push({ name, type, placeholder: m[0] });
  }
  return vars;
}

function variableInputType(type) {
  switch (type) {
    case 'date': return 'date';
    case 'daterange': return 'daterange';
    case 'month': return 'month';
    default: return 'text';
  }
}

function humanLabel(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}

function showPromptVarsModal(promptText, vars) {
  const modal = document.getElementById('prompt-vars-modal');
  const fields = document.getElementById('prompt-vars-fields');
  fields.innerHTML = '';
  // Destroy any previous flatpickr instances
  if (modal._flatpickrInstances) {
    modal._flatpickrInstances.forEach(fp => fp.destroy());
  }
  modal._flatpickrInstances = [];

  for (const v of vars) {
    const wrapper = document.createElement('div');
    const label = document.createElement('label');
    label.className = 'block text-xs text-zinc-400 mb-1';
    label.textContent = humanLabel(v.name) + (v.type !== 'string' ? ` (${v.type})` : '');
    wrapper.appendChild(label);

    const inputType = variableInputType(v.type);

    if (inputType === 'daterange') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Select date range...';
      inp.className = 'w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 outline-none cursor-pointer';
      inp.dataset.varName = v.name;
      inp.dataset.varType = 'daterange';
      inp.readOnly = true;
      wrapper.appendChild(inp);
      // Initialize flatpickr after DOM insertion
      setTimeout(() => {
        const fp = flatpickr(inp, {
          mode: 'range',
          dateFormat: 'Y-m-d',
          allowInput: false,
          static: true,
          appendTo: wrapper,
        });
        modal._flatpickrInstances.push(fp);
      }, 0);
    } else if (inputType === 'date') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Select date...';
      inp.className = 'w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 outline-none cursor-pointer';
      inp.dataset.varName = v.name;
      inp.readOnly = true;
      wrapper.appendChild(inp);
      setTimeout(() => {
        const fp = flatpickr(inp, {
          dateFormat: 'Y-m-d',
          allowInput: false,
          static: true,
          appendTo: wrapper,
        });
        modal._flatpickrInstances.push(fp);
      }, 0);
    } else if (inputType === 'month') {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Select month...';
      inp.className = 'w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 outline-none cursor-pointer';
      inp.dataset.varName = v.name;
      inp.dataset.varType = 'month';
      inp.readOnly = true;
      wrapper.appendChild(inp);
      setTimeout(() => {
        const fp = flatpickr(inp, {
          dateFormat: 'Y-m',
          allowInput: false,
          static: true,
          appendTo: wrapper,
          plugins: [],
          disableMobile: true,
          onChange: function(selectedDates, dateStr, instance) {
            // flatpickr doesn't have a native month-only mode, so we use default with day hidden via CSS
          },
        });
        modal._flatpickrInstances.push(fp);
      }, 0);
    } else {
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-1.5 text-sm text-zinc-200 focus:border-indigo-500 outline-none';
      inp.dataset.varName = v.name;
      wrapper.appendChild(inp);
    }

    fields.appendChild(wrapper);
  }

  modal.classList.remove('hidden');
  const firstInput = fields.querySelector('input');
  if (firstInput && !firstInput.readOnly) firstInput.focus();

  // Store prompt text on modal for submit handler
  modal._promptText = promptText;
  modal._vars = vars;
}

function collectVarValues() {
  const fields = document.getElementById('prompt-vars-fields');
  const values = {};
  const inputs = fields.querySelectorAll('input[data-var-name]');
  for (const inp of inputs) {
    const name = inp.dataset.varName;
    if (inp.dataset.varType === 'daterange') {
      // flatpickr range mode stores "YYYY-MM-DD to YYYY-MM-DD" in the value
      const parts = inp.value.split(' to ');
      values[name] = { from: parts[0] || '', to: parts[1] || '' };
    } else {
      values[name] = inp.value;
    }
  }
  return values;
}

function substituteVars(text, vars, values) {
  let result = text;
  for (const v of vars) {
    const val = values[v.name];
    let replacement = '';
    if (v.type === 'daterange' && val && typeof val === 'object') {
      replacement = [val.from, val.to].filter(Boolean).join(' to ');
    } else if (v.type === 'month' && val) {
      // flatpickr gives YYYY-MM or YYYY-MM-DD, format to "March 2026"
      const parts = val.split('-');
      const d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1);
      replacement = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    } else {
      replacement = val || '';
    }
    // Replace all occurrences of this variable (with or without type suffix)
    const escaped = v.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(`\\{\\$${escaped}(?::\\w+)?\\}`, 'g'), replacement);
  }
  return result;
}

// Modal event handlers
document.getElementById('prompt-vars-cancel').addEventListener('click', () => {
  const modal = document.getElementById('prompt-vars-modal');
  if (modal._flatpickrInstances) modal._flatpickrInstances.forEach(fp => fp.destroy());
  modal._flatpickrInstances = [];
  modal.classList.add('hidden');
});

document.getElementById('prompt-vars-clear').addEventListener('click', () => {
  const fields = document.getElementById('prompt-vars-fields');
  fields.querySelectorAll('input').forEach(inp => inp.value = '');
  const firstInput = fields.querySelector('input');
  if (firstInput) firstInput.focus();
});

document.getElementById('prompt-vars-submit').addEventListener('click', () => {
  const modal = document.getElementById('prompt-vars-modal');
  const values = collectVarValues();
  let text = substituteVars(modal._promptText, modal._vars, values);
  text = expandPromptMacros(text);
  const restoreThink = modal._restoreThink;
  if (modal._flatpickrInstances) modal._flatpickrInstances.forEach(fp => fp.destroy());
  modal._flatpickrInstances = [];
  modal._restoreThink = undefined;
  modal.classList.add('hidden');
  if (restoreThink !== undefined) {
    // Session init with variables — auto-submit, then restore Think
    sendMessage(text, null, { sessionInit: true }).then(() => {
      state.thinkEnabled = restoreThink;
      thinkToggle.checked = restoreThink;
    });
  } else if (state.currentConversationId && state.sessionType) {
    input.value = text;
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    input.focus();
  }
});

// Close modal on Escape
document.getElementById('prompt-vars-modal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = document.getElementById('prompt-vars-modal');
    if (modal._flatpickrInstances) modal._flatpickrInstances.forEach(fp => fp.destroy());
    modal._flatpickrInstances = [];
    // Restore Think if cancelled during session init
    if (modal._restoreThink !== undefined) {
      state.thinkEnabled = modal._restoreThink;
      thinkToggle.checked = modal._restoreThink;
      modal._restoreThink = undefined;
    }
    modal.classList.add('hidden');
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('prompt-vars-submit').click();
  }
});

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
    item.className = 'group flex items-center gap-1 px-3 py-2 border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors cursor-pointer';
    item.dataset.id = p.id;

    // Drag grip handle — only this enables dragging
    const grip = document.createElement('span');
    grip.className = 'cursor-grab text-zinc-600 hover:text-zinc-400 text-xs select-none shrink-0';
    grip.textContent = '⠿';
    grip.addEventListener('mousedown', () => { item.draggable = true; });
    grip.addEventListener('mouseup', () => { item.draggable = false; });

    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      item.draggable = false;
      dragSrcEl = null;
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

    const editBtn = document.createElement('button');
    editBtn.className = 'text-zinc-600 hover:text-zinc-300 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startTitleEdit(titleSpan, async (newTitle) => {
        await fetch(`/api/prompts/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
      });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/prompts/${p.id}`, { method: 'DELETE' });
      refreshPrompts();
    });

    item.addEventListener('click', () => {
      if (!requireSession()) return;
      const vars = extractPromptVariables(p.text);
      if (vars.length > 0) {
        showPromptVarsModal(p.text, vars);
      } else {
        input.value = expandPromptMacros(p.text);
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
        input.focus();
      }
    });

    item.appendChild(grip);
    item.appendChild(titleSpan);
    item.appendChild(editBtn);
    item.appendChild(delBtn);
    promptList.appendChild(item);
  }
}

// ── Tasks ─────────────────────────────────────────────
async function refreshTasks() {
  try {
    const tasks = await (await fetch('/api/tasks')).json();
    renderTasks(tasks);
  } catch {}
}

function renderTasks(tasks) {
  taskList.innerHTML = '';
  let dragSrcEl = null;

  for (const t of tasks) {
    const item = document.createElement('div');
    item.className = 'group flex items-center gap-1 px-3 py-2 border-b border-zinc-800/50 hover:bg-zinc-900 transition-colors cursor-pointer';
    item.dataset.id = t.id;

    const grip = document.createElement('span');
    grip.className = 'cursor-grab text-zinc-600 hover:text-zinc-400 text-xs select-none shrink-0';
    grip.textContent = '⠿';
    grip.addEventListener('mousedown', () => { item.draggable = true; });
    grip.addEventListener('mouseup', () => { item.draggable = false; });

    item.addEventListener('dragstart', (e) => {
      dragSrcEl = item;
      item.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.style.opacity = '1';
      item.draggable = false;
      dragSrcEl = null;
      taskList.querySelectorAll('[data-id]').forEach(el => el.classList.remove('border-t-indigo-500'));
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
      taskList.insertBefore(dragSrcEl, item);
      const ids = [...taskList.querySelectorAll('[data-id]')].map(el => el.dataset.id);
      await fetch('/api/tasks/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
    });

    const titleSpan = document.createElement('span');
    titleSpan.className = 'flex-1 text-xs text-zinc-300';
    titleSpan.textContent = t.title || t.text.slice(0, 60);

    const editBtn = document.createElement('button');
    editBtn.className = 'text-zinc-600 hover:text-zinc-300 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    editBtn.textContent = '✎';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      startTitleEdit(titleSpan, async (newTitle) => {
        await fetch(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
      });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'text-zinc-600 hover:text-red-400 text-xs px-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0';
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await fetch(`/api/tasks/${t.id}`, { method: 'DELETE' });
      refreshTasks();
    });

    item.addEventListener('click', () => {
      if (!requireSession()) return;
      // Load task text into input and activate list mode
      input.value = t.text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
      if (t.text.startsWith('- ')) {
        if (!state.listMode) toggleListMode(true);
      }
      input.focus();
    });

    item.appendChild(grip);
    item.appendChild(titleSpan);
    item.appendChild(editBtn);
    item.appendChild(delBtn);
    taskList.appendChild(item);
  }
}

clearPromptBtn.addEventListener('click', () => {
  input.value = '';
  input.style.height = 'auto';
  if (state.listMode) toggleListMode(false);
  input.focus();
});

savePromptBtn.addEventListener('click', async () => {
  const text = input.value.trim();
  if (!text) return;
  const origHTML = savePromptBtn.innerHTML;
  savePromptBtn.disabled = true;
  savePromptBtn.style.opacity = '0.5';
  try {
    const endpoint = state.listMode ? '/api/tasks' : '/api/prompts';
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    input.value = '';
    input.style.height = 'auto';
    if (state.listMode) {
      toggleListMode(false);
      refreshTasks();
    } else {
      refreshPrompts();
    }
  } finally {
    savePromptBtn.disabled = false;
    savePromptBtn.style.opacity = '';
    savePromptBtn.innerHTML = origHTML;
  }
});

function showOverwriteConfirm(label) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '200',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.6)',
    });
    const card = document.createElement('div');
    Object.assign(card.style, {
      background: '#27272a', border: '1px solid #3f3f46', borderRadius: '12px',
      padding: '20px 24px', maxWidth: '360px', width: '100%',
      boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    });
    const msg = document.createElement('div');
    Object.assign(msg.style, { color: '#e4e4e7', fontSize: '14px', marginBottom: '16px', lineHeight: '1.5' });
    msg.textContent = `A ${label} prompt already exists for this session. Overwrite it?`;
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const cancelBtn = document.createElement('button');
    Object.assign(cancelBtn.style, {
      padding: '6px 16px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
      border: '1px solid #3f3f46', background: 'transparent', color: '#a1a1aa',
    });
    cancelBtn.textContent = 'Cancel';
    const confirmBtn = document.createElement('button');
    Object.assign(confirmBtn.style, {
      padding: '6px 16px', fontSize: '13px', borderRadius: '6px', cursor: 'pointer',
      border: 'none', background: '#dc2626', color: '#fff',
    });
    confirmBtn.textContent = 'Overwrite';
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    card.appendChild(msg);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    const close = (result) => { overlay.remove(); resolve(result); };
    cancelBtn.addEventListener('click', () => close(false));
    confirmBtn.addEventListener('click', () => close(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
  });
}

saveSessionBtn.addEventListener('click', async () => {
  const text = input.value.trim();
  if (!text || !state.sessionType) return;
  // Check if session prompt already exists for this color
  try {
    const sessions = await (await fetch('/api/sessions')).json();
    const existing = sessions.find(s => s.color === state.sessionType);
    if (existing) {
      const ok = await showOverwriteConfirm('session');
      if (!ok) return;
    }
  } catch {}
  const origHTML = saveSessionBtn.innerHTML;
  saveSessionBtn.disabled = true;
  saveSessionBtn.style.opacity = '0.5';
  try {
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, color: state.sessionType }),
    });
    input.value = '';
    input.style.height = 'auto';
    refreshSessions();
  } finally {
    saveSessionBtn.disabled = false;
    saveSessionBtn.style.opacity = '';
    saveSessionBtn.innerHTML = origHTML;
  }
});

saveCompactBtn.addEventListener('click', async () => {
  const text = input.value.trim();
  if (!text || !state.sessionType) return;
  // Check if compact prompt already exists for this color
  try {
    const compacts = await (await fetch('/api/compacts')).json();
    const existing = compacts.find(c => c.color === state.sessionType);
    if (existing) {
      const ok = await showOverwriteConfirm('compact');
      if (!ok) return;
    }
  } catch {}
  const origHTML = saveCompactBtn.innerHTML;
  saveCompactBtn.disabled = true;
  saveCompactBtn.style.opacity = '0.5';
  try {
    await fetch('/api/compacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, color: state.sessionType }),
    });
    input.value = '';
    input.style.height = 'auto';
    refreshCompacts();
  } finally {
    saveCompactBtn.disabled = false;
    saveCompactBtn.style.opacity = '';
    saveCompactBtn.innerHTML = origHTML;
  }
});

// ── Resize divider (chat/prompt) ──────────────────────
{
  const divider = document.getElementById('resize-divider');
  const form = document.getElementById('prompt-form');
  let dragging = false;
  let startY, startH;
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = form.offsetHeight;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    const newH = Math.max(80, Math.min(window.innerHeight * 0.6, startH + delta));
    form.style.height = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('promptFormHeight', form.style.height);
  });
  const saved = localStorage.getItem('promptFormHeight');
  if (saved) form.style.height = saved;
}

// ── Resize divider (sidebar) ─────────────────────────
{
  const divider = document.getElementById('sidebar-divider');
  const sidebar = document.getElementById('sidebar');
  let dragging = false;
  let startX, startW;
  divider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = sidebar.offsetWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.max(150, Math.min(window.innerWidth * 0.4, startW + delta));
    sidebar.style.width = newW + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('sidebarWidth', sidebar.style.width);
  });
  const savedW = localStorage.getItem('sidebarWidth');
  if (savedW) sidebar.style.width = savedW;
}

// ── Init ──────────────────────────────────────────────
(async function init() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    state.location = cfg.location || '';
    if (cfg.sourceDir) {
      const short = cfg.sourceDir.replace(/^\/home\/[^/]+/, '~');
      state.sourceDir = short;
      const projBtn = document.getElementById('project-btn');
      projBtn.title = 'Project: ' + short;
      projBtn.classList.remove('hidden');
      if (cfg.terminal) {
        projBtn.addEventListener('click', () => fetch('/api/terminal', { method: 'POST' }));
      }
    }
  } catch {}
  await refreshSidebar();
  // Restore active session from localStorage
  if (state.currentConversationId) {
    const exists = state.conversations.find(c => c.id === state.currentConversationId);
    if (exists) {
      const savedType = state.sessionColors[state.currentConversationId] || null;
      state.sessionType = savedType;
      const color = savedType ? getComputedStyle(document.documentElement).getPropertyValue(`--btn-${savedType}`).trim() : '';
      input.style.borderColor = color || '';
      renderSidebar();
      const conv = await api.getConversation(state.currentConversationId);
      renderMessages(conv.messages);
      updateContextBar(conv.tokenCount);
    } else {
      // Conversation no longer exists on server
      state.currentConversationId = null;
      state.sessionType = null;
      persistActiveConversation();
    }
  }
  updateInputLock();
  refreshPrompts();
  refreshSessions();
  refreshCompacts();
  refreshTasks();
  pollLLM();
  setInterval(pollLLM, 5000);
  pollInternet();
  setInterval(pollInternet, 30000);
  pollSearch();
  setInterval(pollSearch, 60000);
  initPluginStatuses();
  refreshSlots();
  setInterval(refreshSlots, 5000);
})();
