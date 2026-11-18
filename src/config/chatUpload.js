import multer from 'multer';
import path from 'path';

import config from './env.js';
import { AppError } from '../middleware/errorHandler.js';

// Chat attachments are read in memory for the current answer only — they are
// never written to disk and never enter the document corpus.
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.txt', '.md', '.csv', '.json',
  '.png', '.jpg', '.jpeg', '.webp',
]);

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ALLOWED_EXTENSIONS.has(ext)) {
    return cb(null, true);
  }

  cb(
    Object.assign(
      new Error('Unsupported attachment type. Use PDF, TXT, MD, CSV, JSON, PNG, JPG or WEBP.'),
      { code: 'INVALID_ATTACHMENT_TYPE' }
    ),
    false
  );
};

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: {
    fileSize: config.CHAT_ATTACHMENT_MAX_MB * 1024 * 1024,
    files:    config.CHAT_ATTACHMENT_MAX_FILES,
  },
});

const uploadArray = upload.array('attachments', config.CHAT_ATTACHMENT_MAX_FILES);

/**
 * Parses multipart chat messages and maps multer failures to 4xx AppErrors so
 * students get an actionable message instead of a 500.
 */
export const chatAttachments = (req, res, next) => {
  uploadArray(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new AppError(
        `Each attachment must be ${config.CHAT_ATTACHMENT_MAX_MB} MB or smaller.`,
        413
      ));
    }

    if (
      err.code === 'LIMIT_FILE_COUNT' ||
      err.code === 'LIMIT_UNEXPECTED_FILE'
    ) {
      return next(new AppError(
        `Attach at most ${config.CHAT_ATTACHMENT_MAX_FILES} files using the "attachments" field.`,
        400
      ));
    }

    if (err.code === 'INVALID_ATTACHMENT_TYPE') {
      return next(new AppError(err.message, 415));
    }

    return next(err);
  });
};
