import { Router } from 'express';

import { login, logout, getMe } from '../controllers/authController.js';
import authenticate             from '../middleware/authenticate.js';
import { authLimiter }          from '../middleware/rateLimiter.js';

const router = Router();

// ── Public routes (no JWT required) ──────────────────────────────────────────

// POST /api/auth/login
router.post('/login', authLimiter, login);

// POST /api/auth/logout
router.post('/logout', logout);

// ── Protected routes (JWT required) ──────────────────────────────────────────

// GET /api/auth/me
router.get('/me', authenticate, getMe);

export default router;
