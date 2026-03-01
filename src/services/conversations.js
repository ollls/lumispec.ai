import { randomUUID } from 'crypto';

/** @type {Map<string, Conversation>} */
const store = new Map();

function create(title) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const conv = {
    id,
    title: title || 'New conversation',
    messages: [],
    slotId: null,
    tokenCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  store.set(id, conv);
  return conv;
}

function list() {
  return [...store.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, title, slotId, tokenCount, createdAt, updatedAt }) => ({
      id, title, slotId, tokenCount, createdAt, updatedAt,
    }));
}

function get(id) {
  return store.get(id) || null;
}

function remove(id) {
  return store.delete(id);
}

function updateTitle(id, title) {
  const conv = store.get(id);
  if (!conv) return null;
  conv.title = title;
  conv.updatedAt = new Date().toISOString();
  return conv;
}

function addMessage(id, role, content) {
  const conv = store.get(id);
  if (!conv) return null;
  const msg = { role, content };
  conv.messages.push(msg);
  conv.updatedAt = new Date().toISOString();
  return msg;
}

function updateMessageContent(id, msgIndex, content) {
  const conv = store.get(id);
  if (!conv || !conv.messages[msgIndex]) return null;
  conv.messages[msgIndex].content = content;
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
  return conv;
}

export default {
  create, list, get, remove, updateTitle,
  addMessage, updateMessageContent, setSlot, setTokenCount,
};
