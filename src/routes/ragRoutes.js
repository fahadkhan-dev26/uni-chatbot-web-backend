import { Router } from 'express';

import {
  queryRag,
  getStatus,
  reEmbedDocumentHandler,
  reEmbedAll,
} from '../controllers/ragController.js';

import authenticate from '../middleware/authenticate.js';
import authorize    from '../middleware/authorize.js';

const router = Router();

// ── Authenticated (students + admins) ─────────────────────────────────────────

// POST /api/rag/query
router.post('/query', authenticate, queryRag);

// ── Admin only ────────────────────────────────────────────────────────────────

// GET /api/rag/status
router.get('/status',               authenticate, authorize('admin'), getStatus);

// POST /api/rag/embed/:documentId
router.post('/embed/:documentId',   authenticate, authorize('admin'), reEmbedDocumentHandler);

// POST /api/rag/embed-all
router.post('/embed-all',           authenticate, authorize('admin'), reEmbedAll);

export default router;
