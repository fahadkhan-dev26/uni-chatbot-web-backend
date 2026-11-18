import { Router } from 'express';

import {
  sendMessage,
  listHistory,
  getConversation,
  deleteConversationHandler,
  askQuestion,
  aiHealthCheck,
  getConversationHistory,
  listSessions,
} from '../controllers/chatController.js';

import optionalAuthenticate from '../middleware/optionalAuth.js';
import authenticate         from '../middleware/authenticate.js';
import { chatLimiter }      from '../middleware/rateLimiter.js';
import { chatAttachments }  from '../config/chatUpload.js';

const router = Router();

// Express matches routes in registration order, so every fixed path must be
// declared before the '/:id' catch-all.

// ── Public routes — login optional ────────────────────────────────────────────
// optionalAuthenticate runs first so the chat limiter can key by user id when
// a valid token is present, and guests are still allowed through.

// POST /api/chat/message — ask a question, returns answer + citations
// multipart/form-data is accepted for messages with attachments.
router.post('/message', optionalAuthenticate, chatLimiter, chatAttachments, sendMessage);

// GET /api/chat/history — conversations for the caller (guests: ?sessionId=…)
router.get('/history', optionalAuthenticate, listHistory);

// ── Legacy authenticated routes (unchanged) ───────────────────────────────────
// authenticate is applied per-route so Express 5 router.use path-matching
// does not interfere.

// POST /api/chat/ask
router.post('/ask', authenticate, askQuestion);

// GET /api/chat/health
router.get('/health', authenticate, aiHealthCheck);

// GET /api/chat/sessions
router.get('/sessions', authenticate, listSessions);

// GET /api/chat/history/:sessionId
router.get('/history/:sessionId', authenticate, getConversationHistory);

// ── Public single-conversation routes (must come last) ────────────────────────

// GET /api/chat/:id — one conversation (guests: ?sessionId=…)
// DELETE /api/chat/:id — soft-delete a conversation
router.get   ('/:id', optionalAuthenticate, getConversation);
router.delete('/:id', optionalAuthenticate, deleteConversationHandler);

export default router;
