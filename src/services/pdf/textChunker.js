/**
 * textChunker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Splits extracted page text into overlapping chunks suitable for embedding
 * and retrieval.
 *
 * Token approximation:
 *   English text averages ~4 characters per token.
 *   500 tokens ≈ 2 000 chars  |  800 tokens ≈ 3 200 chars
 *   We target 2 400 chars (≈600 tokens) with a 400-char (≈100 token) overlap.
 *
 * Strategy:
 *   1. Try to split on paragraph boundaries (\n\n) first.
 *   2. Fall back to sentence boundaries (. ! ?) when a paragraph is too large.
 *   3. Fall back to hard character splits as a last resort.
 *
 * Each returned chunk records:
 *   - which page it came from
 *   - its index within that page
 *   - estimated token count
 *   - character offset for debugging
 */

/** Characters per chunk target (≈600 tokens @ 4 chars/token) */
const CHUNK_SIZE    = 2400;
/** Overlap in characters (≈100 tokens) */
const CHUNK_OVERLAP = 400;
/** Minimum chunk length — discard smaller fragments */
const MIN_CHUNK     = 100;

/**
 * @typedef {Object} Chunk
 * @property {string} content      - The chunk text
 * @property {number} pageNumber   - Source page (1-based)
 * @property {number} chunkIndex   - 0-based index within this page
 * @property {object} metadata     - { estimatedTokens, charOffset, charLength }
 */

/**
 * Splits text at natural sentence boundaries within the target chunk size.
 *
 * @param {string} text
 * @returns {string[]}
 */
const splitAtSentences = (text) => {
  // Match end of a sentence: period / ! / ? followed by whitespace or end
  const sentencePattern = /(?<=[.!?])\s+(?=[A-Z"'])/g;
  const sentences = text.split(sentencePattern);

  const chunks   = [];
  let   current  = '';

  for (const sentence of sentences) {
    if ((current + sentence).length <= CHUNK_SIZE) {
      current += (current ? ' ' : '') + sentence;
    } else {
      if (current.length >= MIN_CHUNK) chunks.push(current.trim());
      // If the single sentence is itself larger than CHUNK_SIZE, hard-split it
      if (sentence.length > CHUNK_SIZE) {
        for (let i = 0; i < sentence.length; i += CHUNK_SIZE - CHUNK_OVERLAP) {
          const slice = sentence.slice(i, i + CHUNK_SIZE).trim();
          if (slice.length >= MIN_CHUNK) chunks.push(slice);
        }
        current = '';
      } else {
        current = sentence;
      }
    }
  }
  if (current.length >= MIN_CHUNK) chunks.push(current.trim());

  return chunks;
};

/**
 * Chunks a single page's text into overlapping segments.
 *
 * @param {string} pageText   - Full extracted text of one page
 * @param {number} pageNumber - 1-based page number
 * @returns {Chunk[]}
 */
const chunkPageText = (pageText, pageNumber) => {
  if (!pageText || pageText.trim().length < MIN_CHUNK) return [];

  /** @type {string[]} raw text segments before assembling with overlap */
  let segments = [];

  // ── 1. Try paragraph splits first ────────────────────────────────────────
  const paragraphs = pageText.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

  let currentBlock = '';

  for (const para of paragraphs) {
    if ((currentBlock + '\n\n' + para).length <= CHUNK_SIZE) {
      currentBlock += (currentBlock ? '\n\n' : '') + para;
    } else {
      if (currentBlock.length >= MIN_CHUNK) {
        segments.push(currentBlock.trim());
      }
      // If a single paragraph is larger than the target, sentence-split it
      if (para.length > CHUNK_SIZE) {
        const subChunks = splitAtSentences(para);
        segments.push(...subChunks);
        currentBlock = '';
      } else {
        currentBlock = para;
      }
    }
  }
  if (currentBlock.trim().length >= MIN_CHUNK) {
    segments.push(currentBlock.trim());
  }

  // ── 2. Build overlapping chunks from segments ─────────────────────────────
  // Re-join consecutive small segments until CHUNK_SIZE is reached, then
  // include the last CHUNK_OVERLAP characters of the previous chunk at the
  // start of the next one.
  /** @type {Chunk[]} */
  const chunks  = [];
  let   overlap = '';
  let   charOffset = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg  = segments[i];
    const text = overlap ? `${overlap}\n\n${seg}` : seg;

    chunks.push({
      content:    text.trim(),
      pageNumber,
      chunkIndex: chunks.length,
      metadata: {
        estimatedTokens: Math.ceil(text.length / 4),
        charOffset,
        charLength: text.length,
      },
    });

    charOffset += seg.length;
    // Carry the last CHUNK_OVERLAP chars forward as overlap context
    overlap = text.length > CHUNK_OVERLAP ? text.slice(-CHUNK_OVERLAP) : text;
  }

  return chunks;
};

/**
 * Processes all pages and returns a flat array of chunks with global indexes.
 *
 * @param {import('./pdfExtractor.js').PageText[]} pages
 * @returns {Chunk[]}
 */
export const chunkPages = (pages) => {
  /** @type {Chunk[]} */
  const allChunks = [];

  for (const { pageNumber, text } of pages) {
    const pageChunks = chunkPageText(text, pageNumber);
    // chunkIndex is already set per-page inside chunkPageText — that's what
    // the DocumentChunk schema stores (position within the page, not global)
    allChunks.push(...pageChunks);
  }

  return allChunks;
};
