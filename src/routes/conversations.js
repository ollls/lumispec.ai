import { Router } from 'express';
import conversations from '../services/conversations.js';
import slots from '../services/slots.js';
import { streamChatCompletion, parseSSEChunks } from '../services/llm.js';

const router = Router();

// List conversation summaries
router.get('/', (_req, res) => {
  res.json(conversations.list());
});

// Create conversation
router.post('/', (req, res) => {
  const conv = conversations.create(req.body.title);
  res.status(201).json(conv);
});

// Get conversation with messages
router.get('/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

// Delete conversation
router.delete('/:id', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  slots.releaseSlot(req.params.id);
  conversations.remove(req.params.id);
  res.status(204).end();
});

// Update title
router.patch('/:id', (req, res) => {
  const conv = conversations.updateTitle(req.params.id, req.body.title);
  if (!conv) return res.status(404).json({ error: 'Not found' });
  res.json(conv);
});

// Send message + stream response
router.post('/:id/messages', async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Not found' });

  const content = (req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Content is required' });

  // Add user message
  conversations.addMessage(conv.id, 'user', content);

  // Resolve slot
  let slotId = slots.getSlotForConversation(conv.id);
  if (slotId == null) slotId = slots.assignSlot(conv.id);
  if (slotId != null) conversations.setSlot(conv.id, slotId);

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Add assistant placeholder
  const assistantMsg = conversations.addMessage(conv.id, 'assistant', '');
  const msgIndex = conv.messages.length - 1;

  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  let accumulated = '';

  try {
    const upstream = await streamChatCompletion(conv.messages.slice(0, -1), {
      slotId,
      signal: abortController.signal,
    });

    for await (const chunk of parseSSEChunks(upstream)) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        accumulated += delta;
        conversations.updateMessageContent(conv.id, msgIndex, accumulated);
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }

      // Usage info on final chunk
      if (chunk.usage) {
        const tokenCount = chunk.usage.total_tokens || chunk.usage.completion_tokens || 0;
        conversations.setTokenCount(conv.id, tokenCount);
        res.write(`data: ${JSON.stringify({ usage: chunk.usage })}\n\n`);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      const errMsg = err.message || 'LLM request failed';
      // Update assistant message with error
      conversations.updateMessageContent(conv.id, msgIndex, `[Error: ${errMsg}]`);
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();

  // Auto-title from first user message
  const updated = conversations.get(conv.id);
  if (updated && updated.title === 'New conversation' && updated.messages.length >= 1) {
    const firstUser = updated.messages.find(m => m.role === 'user');
    if (firstUser) {
      const title = firstUser.content.length > 60
        ? firstUser.content.slice(0, 60) + '…'
        : firstUser.content;
      conversations.updateTitle(conv.id, title);
    }
  }
});

export default router;
