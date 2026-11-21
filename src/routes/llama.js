import { Router } from 'express';
import { getDashboard, resetSpeed } from '../services/llamaDashboard.js';

const router = Router();

// Everything the Llama Dashboard shows. Sections are cached server-side (GPU 2 s … updates 6 h),
// so the panel may poll this every few seconds.
router.get('/dashboard', async (_req, res) => {
  try {
    res.json(await getDashboard());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// "Check now": asks GitHub again (at most once a minute) and waits for the answer.
router.post('/check-updates', async (_req, res) => {
  try {
    res.json(await getDashboard({ checkUpdates: true }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clears the per-answer speed samples recorded since the app started.
router.post('/speed/reset', (_req, res) => {
  resetSpeed();
  res.json({ ok: true });
});

export default router;
