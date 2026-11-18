import { Router } from 'express';
import { systemStatus } from '../controllers/systemController.js';

const router = Router();

// GET /api/system/status
router.get('/status', systemStatus);

export default router;
