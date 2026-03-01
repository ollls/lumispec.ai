import { Router } from 'express';
import slotsService from '../services/slots.js';

const router = Router();

// Get all slots enriched with conversation mapping
router.get('/', async (_req, res) => {
  const raw = await slotsService.fetchSlots();
  const enriched = raw.map(slot => ({
    ...slot,
    conversationId: slotsService.getConversationForSlot(slot.id) || null,
  }));
  res.json(enriched);
});

// Pin conversation to slot
router.post('/pin', (req, res) => {
  const { conversationId, slotId } = req.body;
  if (conversationId == null || slotId == null) {
    return res.status(400).json({ error: 'conversationId and slotId required' });
  }
  slotsService.pinConversation(conversationId, slotId);
  res.json({ ok: true });
});

// Unpin conversation from slot
router.post('/unpin', (req, res) => {
  const { conversationId } = req.body;
  if (!conversationId) {
    return res.status(400).json({ error: 'conversationId required' });
  }
  slotsService.unpinConversation(conversationId);
  res.json({ ok: true });
});

export default router;
