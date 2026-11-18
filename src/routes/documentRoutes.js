import { Router } from 'express';

import {
  uploadDocuments,
  getDocuments,
  getDocumentById,
  deleteDocument,
  reprocessDocument,
} from '../controllers/documentController.js';

import authenticate from '../middleware/authenticate.js';
import authorize    from '../middleware/authorize.js';
import upload       from '../config/multer.js';

const router = Router();

// ── Multer error handler (must have 4 params for Express to treat as error middleware) ──
// eslint-disable-next-line no-unused-vars
const handleMulterError = (err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      message: `File too large. Maximum allowed size is ${process.env.MAX_FILE_SIZE_MB || 50} MB per file.`,
    });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(400).json({
      success: false,
      message: `Too many files. Maximum ${process.env.MAX_FILES_PER_REQ || 5} files per request.`,
    });
  }
  if (err?.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({ success: false, message: err.message });
  }
  // Any other multer error
  if (err?.name === 'MulterError') {
    return res.status(400).json({ success: false, message: err.message });
  }
  next(err);
};

// All document routes require a valid JWT
// (applied per-route for Express 5 compatibility)

// ── Admin-only routes ─────────────────────────────────────────────────────────

router.post(
  '/upload',
  authenticate,
  authorize('admin'),
  upload.array('documents', 5),
  handleMulterError,
  uploadDocuments
);

router.delete('/:id',           authenticate, authorize('admin'), deleteDocument);
router.post('/:id/reprocess',   authenticate, authorize('admin'), reprocessDocument);

// ── Authenticated routes (students + admins) ──────────────────────────────────

router.get('/',    authenticate, getDocuments);
router.get('/:id', authenticate, getDocumentById);

export default router;
