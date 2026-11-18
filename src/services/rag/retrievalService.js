/**
 * retrievalService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieves the most semantically relevant document chunks for a question.
 *
 * Pipeline:
 *   1. Embed the question using the same model used for document chunks.
 *   2. Load only embedded chunks from MongoDB (isEmbedded: true).
 *   3. Compute cosine similarity between the question vector and each chunk.
 *   4. Return the top-K chunks above the minimum similarity threshold,
 *      populated with their parent document's title, category, and metadata.
 *
 * Performance notes
 * ─────────────────────────────────────────────────────────────────────────────
 * • Only chunks where isEmbedded=true are loaded — processing chunks are
 *   excluded automatically.
 * • Only the fields needed for scoring are fetched (content, embedding,
 *   pageNumber, documentId) — large fields are excluded.
 * • For collections with tens of thousands of chunks, this in-process cosine
 *   search is fast enough (~50–200 ms for 10 k chunks on modern hardware).
 *   MongoDB Atlas Vector Search can replace this later with no API change.
 *
 * Security note
 * ─────────────────────────────────────────────────────────────────────────────
 * Chunk content is treated as untrusted storage — it is never evaluated,
 * executed, or reflected without sanitisation.  Sources are built exclusively
 * from verified DB fields; no content is fabricated.
 */

import DocumentChunk from '../../models/DocumentChunk.js';
import Document      from '../../models/Document.js';
import { embedText, getModelName } from '../embeddings/embeddingService.js';
import config from '../../config/env.js';

// ── Maths ─────────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two vectors of equal length.
 * Both vectors must already be L2-normalised (which the HF pipeline does by
 * default when normalize:true is set) — in that case dot product == cosine.
 *
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} value in [-1, 1]; higher = more similar
 */
export const cosineSimilarity = (a, b) => {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dot  = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
};

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} RetrievalResult
 * @property {string}  chunkId        - DocumentChunk _id
 * @property {string}  documentId     - Parent Document _id
 * @property {string}  documentTitle  - Parent document title
 * @property {string}  category       - Document category slug
 * @property {string}  academicYear   - e.g. "2024/2025" or null
 * @property {number}  pageNumber     - 1-based page in source PDF
 * @property {number}  chunkIndex     - 0-based position within the page
 * @property {string}  content        - Raw chunk text (treat as untrusted)
 * @property {number}  score          - Cosine similarity [0, 1]
 * @property {object}  metadata       - Token count, offsets, etc.
 */

/**
 * Retrieves the top-K most relevant chunks for a natural-language question.
 *
 * @param {string}  question
 * @param {object}  [opts]
 * @param {number}  [opts.topK]       - max results (default: config.RAG_TOP_K)
 * @param {number}  [opts.minScore]   - minimum cosine score (default: config.RAG_MIN_SCORE)
 * @param {string}  [opts.category]   - optional: restrict to one document category
 * @param {string}  [opts.documentId] - optional: restrict to one document
 * @returns {Promise<RetrievalResult[]>}
 */
export const retrieveChunks = async (question, opts = {}) => {
  const topK     = opts.topK     ?? config.RAG_TOP_K;
  const minScore = opts.minScore ?? config.RAG_MIN_SCORE;

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    throw new Error('Question must be a non-empty string.');
  }

  // ── 1. Embed the question ──────────────────────────────────────────────────
  const questionVector = await embedText(question.trim());

  // ── 2. Build chunk query ───────────────────────────────────────────────────
  // Load only the fields needed for scoring; exclude the large embedding field
  // from the projection then add it back — Mongoose excludes _id by default
  // only when you set _id:0, so we keep _id.
  const chunkFilter = { isEmbedded: true };

  if (opts.documentId) {
    chunkFilter.documentId = opts.documentId;
  } else if (opts.category) {
    // Chunks carry no category — resolve the matching documents first
    const categoryDocIds = await Document.distinct('_id', { category: opts.category });
    if (categoryDocIds.length === 0) return [];
    chunkFilter.documentId = { $in: categoryDocIds };
  }

  // ── 3. Fetch candidate chunks ──────────────────────────────────────────────
  // We fetch content + embedding + provenance fields.
  // embedding arrays are ~1.5 KB each (384 floats × 4 bytes).
  // For 5 000 chunks this is ~7.5 MB transferred from MongoDB — acceptable.
  const chunks = await DocumentChunk.find(chunkFilter)
    .select('documentId content embedding pageNumber chunkIndex metadata')
    .lean();   // plain JS objects — faster than Mongoose documents for math

  if (chunks.length === 0) {
    return [];
  }

  // ── 4. Score every chunk ───────────────────────────────────────────────────
  // Dimension guard: chunks embedded with a previous EMBEDDING_MODEL cannot be
  // compared with the current query vector, so they are skipped instead of
  // throwing and failing the whole request.
  const dimensions = questionVector.length;
  const scored = chunks
    .filter((c) => Array.isArray(c.embedding) && c.embedding.length === dimensions)
    .map((c) => ({
      chunk: c,
      score: cosineSimilarity(questionVector, c.embedding),
    }));

  if (scored.length === 0) {
    console.warn(
      '⚠️  No chunks match the current embedding dimensions — run POST /api/rag/embed-all.'
    );
    return [];
  }

  // ── 5. Sort descending, apply threshold, take top-K ───────────────────────
  const topChunks = scored
    .sort((a, b) => b.score - a.score)
    .filter((r) => r.score >= minScore)
    .slice(0, topK);

  if (topChunks.length === 0) {
    return [];
  }

  // ── 6. Enrich results with document metadata ───────────────────────────────
  // Build a deduplicated set of document IDs to fetch in one query
  const docIds = [...new Set(topChunks.map((r) => r.chunk.documentId.toString()))];

  const documents = await Document.find({ _id: { $in: docIds } })
    .select('title category academicYear')
    .lean();

  const docMap = Object.fromEntries(documents.map((d) => [d._id.toString(), d]));

  // ── 7. Build final result objects ──────────────────────────────────────────
  return topChunks.map(({ chunk, score }) => {
    const doc = docMap[chunk.documentId.toString()] ?? {};

    return {
      chunkId:       chunk._id.toString(),
      documentId:    chunk.documentId.toString(),
      documentTitle: doc.title       ?? 'Unknown Document',
      category:      doc.category    ?? null,
      academicYear:  doc.academicYear ?? null,
      pageNumber:    chunk.pageNumber,
      chunkIndex:    chunk.chunkIndex,
      // content is from the DB — treat as untrusted in any template/LLM context
      content:       chunk.content,
      score:         Math.round(score * 10000) / 10000,  // 4 decimal places
      metadata:      chunk.metadata ?? {},
    };
  });
};

/**
 * Returns embedding stats for the entire collection.
 * Used by the admin status endpoint.
 *
 * @returns {Promise<{ total: number, embedded: number, pending: number, modelName: string }>}
 */
export const getEmbeddingStats = async () => {
  const [total, embedded] = await Promise.all([
    DocumentChunk.countDocuments({}),
    DocumentChunk.countDocuments({ isEmbedded: true }),
  ]);

  return {
    total,
    embedded,
    pending:   total - embedded,
    modelName: getModelName(),
  };
};
