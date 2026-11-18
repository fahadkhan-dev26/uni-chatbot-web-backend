import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from the project root (Backend/)
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Required variables ──────────────────────────────────────────────────────
const required = ['NODE_ENV', 'PORT'];

for (const key of required) {
  if (!process.env[key]) {
    console.warn(`⚠️  Warning: environment variable "${key}" is not set.`);
  }
}

// ── Exported config object ──────────────────────────────────────────────────
const config = {
  NODE_ENV:   process.env.NODE_ENV   || 'development',
  PORT:       parseInt(process.env.PORT, 10) || 5000,
  CLIENT_URL: process.env.CLIENT_URL || 'http://localhost:5173',

  // MongoDB (used in a later step)
  MONGODB_URI: process.env.MONGODB_URI || '',

  // JWT (used in a later step)
  JWT_SECRET:     process.env.JWT_SECRET     || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '7d',

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000,
  RATE_LIMIT_MAX:       parseInt(process.env.RATE_LIMIT_MAX, 10)       || 100,

  // Chat rate limiting (each AI answer runs retrieval + local inference)
  CHAT_RATE_LIMIT_WINDOW_MS: parseInt(process.env.CHAT_RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000,
  CHAT_RATE_LIMIT_MAX:       parseInt(process.env.CHAT_RATE_LIMIT_MAX, 10)       || 20,

  // File uploads
  UPLOAD_DIR:          process.env.UPLOAD_DIR                           || 'uploads',
  MAX_FILE_SIZE_MB:    parseInt(process.env.MAX_FILE_SIZE_MB, 10)       || 50,
  MAX_FILES_PER_REQ:   parseInt(process.env.MAX_FILES_PER_REQ, 10)      || 5,

  // Chat message attachments (kept in memory per request, never stored)
  CHAT_ATTACHMENT_MAX_MB:    parseInt(process.env.CHAT_ATTACHMENT_MAX_MB, 10)    || 10,
  CHAT_ATTACHMENT_MAX_FILES: parseInt(process.env.CHAT_ATTACHMENT_MAX_FILES, 10) || 3,

  // Embeddings
  EMBEDDING_MODEL:     process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2',
  EMBEDDING_MODEL_DIR: process.env.EMBEDDING_MODEL_DIR || './models',
  EMBEDDING_BATCH_SIZE: parseInt(process.env.EMBEDDING_BATCH_SIZE, 10) || 32,

  // RAG retrieval
  // 0.35 is the floor for this embedding model: relevant question/chunk pairs
  // usually score 0.45–0.75, while unrelated text rarely exceeds 0.25.
  RAG_TOP_K:            parseInt(process.env.RAG_TOP_K, 10)            || 5,
  RAG_MIN_SCORE:        parseFloat(process.env.RAG_MIN_SCORE)          || 0.35,

  // Ollama
  OLLAMA_BASE_URL:    process.env.OLLAMA_BASE_URL    || 'http://localhost:11434',
  OLLAMA_MODEL:       process.env.OLLAMA_MODEL       || 'llama3.2',
  // Multi-modal model (e.g. llava) used only when the student attaches images.
  // Leave empty to keep text-only answers; images are then skipped with a notice.
  OLLAMA_VISION_MODEL: process.env.OLLAMA_VISION_MODEL || '',
  OLLAMA_TIMEOUT_MS:  parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 120_000,
  OLLAMA_MAX_TOKENS:  parseInt(process.env.OLLAMA_MAX_TOKENS, 10)  || 1024,
  OLLAMA_TEMPERATURE: parseFloat(process.env.OLLAMA_TEMPERATURE)   || 0.1,
  // Ollama defaults to 2048 tokens and silently drops the beginning of a
  // longer prompt (our system rules) — 5 × 600-token passages exceed that.
  OLLAMA_NUM_CTX:     parseInt(process.env.OLLAMA_NUM_CTX, 10)     || 8192,
};

export default config;
