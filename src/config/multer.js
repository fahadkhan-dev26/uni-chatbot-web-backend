import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID } from 'crypto';
import config from './env.js';

// ── Resolve the uploads directory ─────────────────────────────────────────────
// Serverless filesystems are read-only outside the temp directory, and the
// empty uploads/ folder is not always shipped in the function bundle, so a
// failed mkdir must not crash the whole app at import time.
const resolveUploadDir = () => {
  const configured = path.resolve(config.UPLOAD_DIR);

  try {
    if (!fs.existsSync(configured)) {
      fs.mkdirSync(configured, { recursive: true });
    }
    return configured;
  } catch (err) {
    const fallback = path.join(os.tmpdir(), 'uac-uploads');
    fs.mkdirSync(fallback, { recursive: true });
    console.warn(
      `⚠️  Upload dir "${configured}" is not writable (${err.code ?? err.message}); using "${fallback}".`
    );
    return fallback;
  }
};

const uploadDir = resolveUploadDir();

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
