import { Router } from 'express';
import { listTemplates, createTemplate, updateTemplate, deleteTemplate, getTemplate, reorderTemplates } from '../services/templates.js';
import { collectChatCompletion } from '../services/llm.js';
import { sanitizeTemplate, reviewTemplateHtml } from '../services/templateReview.js';
import config from '../config.js';

const router = Router();

// ── LLM review ──────────────────────────────────────────────────────────────────────────────
// One review per template at a time; a second request while one runs joins it. The template is
// saved raw first (so nothing is lost if llama-server is down) and `review.status` on the record
// goes pending → done | failed. The frontend polls GET /:id until it leaves pending.

const inFlight = new Map();

function reviewTemplate(id) {
  if (inFlight.has(id)) return inFlight.get(id);
  const job = (async () => {
    const template = getTemplate(id);
    if (!template) return null;
    const result = await reviewTemplateHtml(template.html, template.type, {
      complete: collectChatCompletion,
      log: (line) => console.log(line),
      notes: template.notes, // context only; the reviewer's answer is markup, the notes stay on the record
    });
    const review = {
      status: result.applied ? 'done' : 'failed',
      changed: result.changed,
      issues: result.issues,
      remaining: result.remaining,
      reason: result.reason,
      at: new Date().toISOString(),
    };
    // The template may have been deleted while the model was working — updateTemplate returns null then.
    return updateTemplate(id, result.applied ? { html: result.html, review } : { review });
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, job);
  return job;
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

router.get('/', (_req, res) => {
  res.json(listTemplates());
});

router.get('/:id', (req, res) => {
  const template = getTemplate(req.params.id);
  if (!template) return res.status(404).json({ error: 'not found' });
  res.json(template);
});

// Save. `review: false` in the body (or TEMPLATE_AUTO_REVIEW=0) skips the LLM review; otherwise the
// raw template is returned at once with review.status 'pending' and the review runs in the background.
router.post('/', (req, res) => {
  const { name, type, html } = req.body;
  if (!name?.trim() || !html?.trim()) return res.status(400).json({ error: 'name and html required' });
  const wantReview = config.templateAutoReview && req.body.review !== false;
  const review = wantReview
    ? { status: 'pending', at: new Date().toISOString() }
    : { status: 'skipped', at: new Date().toISOString() };
  const created = createTemplate(name.trim(), type || 'html', sanitizeTemplate(html), review);
  res.json(created);
  if (wantReview) {
    reviewTemplate(created.id).catch(err => {
      console.error('[template-review]', err.message);
      updateTemplate(created.id, { review: { status: 'failed', reason: err.message, at: new Date().toISOString() } });
    });
  }
});

// `notes` (author's instructions to the assistant, see services/templates.js) may be set on its own;
// an empty string clears them. A leading HTML comment in `html` sets them too.
router.patch('/:id', (req, res) => {
  const { name, type, html, notes } = req.body;
  if (!name?.trim() && !html?.trim() && typeof notes !== 'string') return res.status(400).json({ error: 'name, html or notes required' });
  const updates = {};
  if (name?.trim()) updates.name = name.trim();
  if (type?.trim()) updates.type = type.trim();
  if (html?.trim()) updates.html = sanitizeTemplate(html.trim());
  if (typeof notes === 'string') updates.notes = notes;
  const template = updateTemplate(req.params.id, updates);
  if (!template) return res.status(404).json({ error: 'not found' });
  res.json(template);
});

router.put('/reorder', (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids array required' });
  res.json(reorderTemplates(ids));
});

// On-demand review (the ⚡ button) — same flow as the automatic one, awaited.
router.post('/:id/optimize', async (req, res) => {
  if (!getTemplate(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const updated = await reviewTemplate(req.params.id);
    if (!updated) return res.status(404).json({ error: 'not found' });
    if (updated.review?.status !== 'done') {
      return res.status(500).json({ error: updated.review?.reason || 'review failed', template: updated });
    }
    res.json({ ok: true, template: updated });
  } catch (err) {
    console.error('[template-optimize]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  deleteTemplate(req.params.id);
  res.json({ ok: true });
});

export default router;
