/**
 * pdfExtractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts text from a PDF file page-by-page using pdfjs-dist v6 (legacy
 * Node build).  Returns an array of page objects so upstream code retains
 * exact page-number provenance for every chunk.
 *
 * Uses the legacy build as recommended by pdfjs-dist for Node.js environments.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';

const require = createRequire(import.meta.url);

// pdfjs-dist v6 no longer falls back to an inline worker: leaving workerSrc
// empty makes getDocument() reject with "Setting up fake worker failed".
// Point it at the bundled legacy worker so extraction works in Node.
GlobalWorkerOptions.workerSrc = pathToFileURL(
  require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
).href;

/**
 * @typedef {Object} PageText
 * @property {number} pageNumber - 1-based page number
 * @property {string} text       - Extracted plain text for this page
 * @property {number} charCount  - Number of characters extracted
 */

/**
 * Extracts text from every page of a PDF buffer (in-memory chat attachments).
 *
 * @param {Buffer|Uint8Array} fileBuffer - Raw PDF bytes
 * @returns {Promise<{ pages: PageText[], totalPages: number }>}
 * @throws {Error} if the buffer cannot be parsed
 */
export const extractPdfTextFromBuffer = async (fileBuffer) => {
  // Copy into a plain Uint8Array — pdfjs-dist requires this in Node and may
  // detach the underlying buffer.
  const data = new Uint8Array(fileBuffer);

  const loadingTask = getDocument({
    data,
    // Suppress pdfjs console warnings for documents with no metadata
    verbosity: 0,
    // Disable range requests and fetch — not applicable in Node
    disableRange:        true,
    disableStream:       true,
    disableAutoFetch:    true,
  });

  const pdfDocument = await loadingTask.promise;

  try {
    const totalPages  = pdfDocument.numPages;

    /** @type {PageText[]} */
    const pages = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page        = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Join text items; insert a newline when a new paragraph block starts
      let pageText = '';
      let lastY    = null;

      for (const item of textContent.items) {
        // `item` can be a TextItem or TextMarkedContent
        if (!('str' in item)) continue;

        const currentY = item.transform ? item.transform[5] : null;

        // Heuristic line break: vertical position changed by more than 2pt
        if (lastY !== null && currentY !== null && Math.abs(currentY - lastY) > 2) {
          pageText += '\n';
        }

        pageText += item.str;

        if (item.hasEOL) {
          pageText += '\n';
        }

        lastY = currentY;
      }

      // Normalise whitespace: collapse multiple blank lines to two
      pageText = pageText
        .replace(/[ \t]+/g, ' ')          // collapse horizontal whitespace
        .replace(/\n{3,}/g, '\n\n')       // max two consecutive newlines
        .trim();

      pages.push({
        pageNumber: pageNum,
        text:       pageText,
        charCount:  pageText.length,
      });
    }

    return { pages, totalPages };

  } finally {
    // Releases the worker; PDFDocumentProxy.destroy() was removed in v6
    await loadingTask.destroy();
  }
};

/**
 * Extracts text from every page of a PDF file.
 *
 * @param {string} filePath - Absolute path to the PDF on disk
 * @returns {Promise<{ pages: PageText[], totalPages: number }>}
 * @throws {Error} if the file cannot be read or parsed
 */
export const extractPdfText = async (filePath) => {
  const fileBuffer = fs.readFileSync(filePath);
  return extractPdfTextFromBuffer(fileBuffer);
};
