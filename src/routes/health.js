import { Router } from 'express';
import slotsService from '../services/slots.js';

const router = Router();

router.get('/', async (_req, res) => {
  const health = await slotsService.checkHealth();
  if (health.status === 'error') {
    return res.status(502).json(health);
  }
  res.json(health);
});

export default router;
