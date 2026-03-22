import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PINNED_DIR = join(__dirname, '..', '..', 'data', 'pinned');

/** @type {Map<string, Conversation>} */
const store = new Map();

// ── Persistence helpers ──────────────────────────────
function savePinned(id) {
  const conv = store.get(id);
  if (!conv) return;
  mkdirSync(PINNED_DIR, { recursive: true });
  const data = { ...conv, slotId: null };
  writeFileSync(join(PINNED_DIR, `${id}.json`), JSON.stringify(data, null, 2));
}

function removePinned(id) {
  const file = join(PINNED_DIR, `${id}.json`);
  if (existsSync(file)) unlinkSync(file);
}

function loadPinned() {
  if (!existsSync(PINNED_DIR)) return;
  for (const f of readdirSync(PINNED_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const conv = JSON.parse(readFileSync(join(PINNED_DIR, f), 'utf-8'));
      conv.slotId = null;
      store.set(conv.id, conv);
    } catch (e) {
      console.warn(`[pinned] failed to load ${f}:`, e.message);
    }
  }
}

// Load pinned conversations on startup
loadPinned();

// ── CRUD ─────────────────────────────────────────────
function create(title) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const conv = {
    id,
    title: title || 'New conversation',
    messages: [],
    slotId: null,
    tokenCount: 0,
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, conv);
  return conv;
}

function list() {
  return [...store.values()]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, title, slotId, tokenCount, pinned, createdAt, updatedAt }) => ({
      id, title, slotId, tokenCount, pinned, createdAt, updatedAt,
    }));
}

function get(id) {
  return store.get(id) || null;
}

function remove(id) {
  removePinned(id);
  return store.delete(id);
}

function updateTitle(id, title) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.title = title;
  conv.updatedAt = new Date().toISOString();
  if (conv.pinned) savePinned(id);
  return conv;
}

function addMessage(id, role, content) {
  const conv = store.get(id);
  if (!conv) return null;
  const msg = { role, content };
  conv.messages.push(msg);
  conv.updatedAt = new Date().toISOString();
  if (conv.pinned) savePinned(id);
  return msg;
}

function updateMessageContent(id, msgIndex, content) {
  const conv = store.get(id);
  if (!conv || !conv.messages[msgIndex]) return null;
  conv.messages[msgIndex].content = content;
  if (conv.pinned) savePinned(id);
  return conv.messages[msgIndex];
}

function setSlot(id, slotId) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.slotId = slotId;
  return conv;
}

function setTokenCount(id, count) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.tokenCount = count;
  conv.updatedAt = new Date().toISOString();
  if (conv.pinned) savePinned(id);
  return conv;
}

function pin(id) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.pinned = true;
  savePinned(id);
  return conv;
}

function unpin(id) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.pinned = false;
  removePinned(id);
  return conv;
}

function compact(id, summary) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.messages = [{ role: 'assistant', content: summary }];
  conv.tokenCount = 0;
  conv.updatedAt = new Date().toISOString();
  if (conv.pinned) savePinned(id);
  return conv;
}

export default {
  create, list, get, remove, updateTitle,
  addMessage, updateMessageContent, setSlot, setTokenCount,
  pin, unpin, compact,
};
