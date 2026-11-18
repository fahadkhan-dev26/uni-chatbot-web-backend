/**
 * attachmentService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns the files a student attaches to a chat message into answer context.
 *
 *   • PDFs            → page-tagged text (citation page numbers stay honest)
 *   • TXT/MD/CSV/JSON → plain text
 *   • PNG/JPG/WEBP    → base64 for the active multi-modal model, if any
 *
 * Attachments are per-message only: nothing is persisted beyond their names,
 * sizes and MIME types. Total prompt text is capped so the model's context
 * window cannot be blown by a large file.
 */

import path from 'node:path';

import { extractPdfTextFromBuffer } from '../pdf/pdfExtractor.js';
import { supportsVision } from '../ai/llmService.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json']);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const MAX_CONTEXT_CHARS = 12_000;
const MAX_CHUNK_CHARS = 3_000;
const MAX_NAME_LENGTH = 160;

const extensionOf = (name = '') => path.extname(name).toLowerCase();

const isPdfFile = (file) =>
  file.mimetype === 'application/pdf' || extensionOf(file.originalname) === '.pdf';

const isTextFile = (file) =>
  TEXT_EXTENSIONS.has(extensionOf(file.originalname)) ||
  file.mimetype?.startsWith('text/') ||
  file.mimetype === 'application/json';

const isImageFile = (file) =>
  Boolean(file.mimetype?.startsWith('image/')) ||
  IMAGE_EXTENSIONS.has(extensionOf(file.originalname));

const safeName = (name) =>
  String(name || 'attachment')
    .replace(/[\\/\r\n\t]/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH) || 'attachment';

/** Splits text near paragraph/word boundaries so prompts stay readable. */
const splitIntoChunks = (text, size) => {
  const chunks = [];
  let rest = text;

  while (rest.length > 0) {
    if (rest.length <= size) {
      chunks.push(rest);
      break;
    }

    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;

    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trim();
  }

  return chunks;
};

/**
 * @param {Express.Multer.File[]} files
 * @returns {Promise<{
 *   passages: Array<{ documentTitle: string, category: string, academicYear: null, pageNumber: number, score: number, content: string }>,
 *   images: Array<{ name: string, type: string, data: string }>,
 *   meta: Array<{ name: string, type: string, size: number }>,
 *   notice: string|null
 * }>}
 */
export const buildAttachmentContext = async (files = []) => {
  const passages = [];
  const images = [];
  const meta = [];
  const notices = [];

  let remaining = MAX_CONTEXT_CHARS;
  let truncated = false;

  for (const file of files) {
    const name = safeName(file.originalname);
    meta.push({
      name,
      type: file.mimetype || 'application/octet-stream',
      size: file.size || 0,
    });

    if (isImageFile(file)) {
      if (supportsVision()) {
        images.push({
          name,
          type: file.mimetype || 'image/png',
          data: file.buffer.toString('base64'),
        });
      } else {
        notices.push(
          `"${name}" was not analysed: image understanding needs a vision-capable ` +
          'model (Gemini, or Ollama with OLLAMA_VISION_MODEL, e.g. "llava").'
        );
      }
      continue;
    }

    let pages;

    try {
      if (isPdfFile(file)) {
        const result = await extractPdfTextFromBuffer(file.buffer);
        pages = result.pages.filter((page) => page.text.trim());
      } else if (isTextFile(file)) {
        const text = file.buffer.toString('utf8').replace(/\u0000/g, '').trim();
        pages = text ? [{ pageNumber: 1, text }] : [];
      } else {
        notices.push(
          `"${name}" was skipped: only PDF, TXT, MD, CSV, JSON and images are supported.`
        );
        continue;
      }
    } catch (err) {
      notices.push(`"${name}" could not be read (${err.message}).`);
      continue;
    }

    if (!pages.length) {
      notices.push(
        `"${name}" has no extractable text (scanned PDFs need OCR before uploading).`
      );
      continue;
    }

    for (const page of pages) {
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const slice = page.text.slice(0, remaining);
      if (slice.length < page.text.length) truncated = true;

      for (const content of splitIntoChunks(slice, MAX_CHUNK_CHARS)) {
        passages.push({
          documentTitle: name,
          category:      'attachment',
          academicYear:  null,
          pageNumber:    page.pageNumber,
          score:         1,
          content,
        });
      }

      remaining -= slice.length;
    }
  }

  if (truncated) {
    notices.push(
      `Only the first ${MAX_CONTEXT_CHARS.toLocaleString('en-US')} characters of the attachments were used.`
    );
  }

  return {
    passages,
    images,
    meta,
    notice: notices.length ? [...new Set(notices)].join(' ') : null,
  };
};
