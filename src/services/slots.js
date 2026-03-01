import config from '../config.js';

// Bidirectional maps: conversationId <-> slotId
const conversationSlotMap = new Map();  // convId → slotId
const slotConversationMap = new Map();  // slotId → convId

let cachedSlots = [];
let healthStatus = { status: 'unknown' };
let healthTimer = null;
let slotsTimer = null;

async function fetchSlots() {
  try {
    const res = await fetch(`${config.llama.baseUrl}/slots`);
    if (!res.ok) throw new Error(`slots ${res.status}`);
    cachedSlots = await res.json();
    return cachedSlots;
  } catch {
    return cachedSlots;
  }
}

async function checkHealth() {
  try {
    const res = await fetch(`${config.llama.baseUrl}/health`);
    healthStatus = await res.json();
    return healthStatus;
  } catch {
    healthStatus = { status: 'error' };
    return healthStatus;
  }
}

function getCachedSlots() {
  return cachedSlots;
}

function getHealth() {
  return healthStatus;
}

function assignSlot(convId) {
  // Already assigned?
  if (conversationSlotMap.has(convId)) {
    return conversationSlotMap.get(convId);
  }

  // Find an idle slot not currently mapped
  for (const slot of cachedSlots) {
    if (!slotConversationMap.has(slot.id) && !slot.is_processing) {
      conversationSlotMap.set(convId, slot.id);
      slotConversationMap.set(slot.id, convId);
      return slot.id;
    }
  }

  return null; // no idle slot available
}

function releaseSlot(convId) {
  const slotId = conversationSlotMap.get(convId);
  if (slotId != null) {
    conversationSlotMap.delete(convId);
    slotConversationMap.delete(slotId);
  }
}

function pinConversation(convId, slotId) {
  // Release any previous mapping for this conversation
  releaseSlot(convId);
  // Release any previous conversation on this slot
  const prevConv = slotConversationMap.get(slotId);
  if (prevConv) conversationSlotMap.delete(prevConv);

  conversationSlotMap.set(convId, slotId);
  slotConversationMap.set(slotId, convId);
}

function unpinConversation(convId) {
  releaseSlot(convId);
}

function getSlotForConversation(convId) {
  return conversationSlotMap.get(convId) ?? null;
}

function getConversationForSlot(slotId) {
  return slotConversationMap.get(slotId) ?? null;
}

function startPolling() {
  // Initial fetch
  checkHealth();
  fetchSlots();

  healthTimer = setInterval(checkHealth, 5000);
  slotsTimer = setInterval(fetchSlots, 3000);
}

function stopPolling() {
  if (healthTimer) clearInterval(healthTimer);
  if (slotsTimer) clearInterval(slotsTimer);
  healthTimer = null;
  slotsTimer = null;
}

export default {
  fetchSlots, checkHealth, getCachedSlots, getHealth,
  assignSlot, releaseSlot,
  pinConversation, unpinConversation,
  getSlotForConversation, getConversationForSlot,
  startPolling, stopPolling,
};
