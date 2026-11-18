import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import config from './env.js';

// ── Ensure uploads directory exists at startup ────────────────────────────────
const uploadDir = path.resolve(config.UPLOAD_DIR);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ── Disk storage ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),

  filename: (_req, file, cb) => {
    // <timestamp>-<uuid>-<sanitised-original-name>
    const ext          = path.extname(file.originalname).toLowerCase();
    const baseName     = path.basename(file.originalname, ext)
                             .replace(/[^a-zA-Z0-9_-]/g, '_')  // sanitise
                             .slice(0, 60);                      // cap length
    const unique       = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    cb(null, `${unique}-${baseName}${ext}`);
  },
});

// ── File filter — PDFs only ───────────────────────────────────────────────────
const fileFilter = (_req, file, cb) => {
  const allowedMimeTypes = ['application/pdf'];
  const allowedExtensions = ['.pdf'];
  const ext = path.extname(file.originalname).toLowerCase();

  if (
    allowedMimeTypes.includes(file.mimetype) &&
    allowedExtensions.includes(ext)
  ) {
    cb(null, true);
  } else {
    cb(
      Object.assign(new Error('Only PDF files are allowed.'), { code: 'INVALID_FILE_TYPE' }),
      false
    );
  }
};

// ── Multer instance ───────────────────────────────────────────────────────────
const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: config.MAX_FILE_SIZE_MB * 1024 * 1024,  // bytes
    files:    config.MAX_FILES_PER_REQ,
  },
});

export default upload;
