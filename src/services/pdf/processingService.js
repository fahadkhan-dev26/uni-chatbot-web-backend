/**
 * processingService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates the full PDF ingestion pipeline for one document:
 *
 *   1. Mark document as "processing"
 *   2. Extract text page-by-page  (pdfExtractor)
 *   3. Split text into chunks     (textChunker)
 *   4. Generate embeddings        (embeddingService)
 *   5. Persist chunks + embeddings (DocumentChunk)
 *   6. Mark document as "completed"
 *
 * On any failure the document is marked "failed" and partial chunks are
 * removed so the document can be safely reprocessed.
 */

import Document      from '../../models/Document.js';
import DocumentChunk from '../../models/DocumentChunk.js';
import { extractPdfText }              from './pdfExtractor.js';
import { chunkPages }                  from './textChunker.js';
import { embedBatch, getModelName }    from '../embeddings/embeddingService.js';
import config from '../../config/env.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const addLog = (doc, stage, status, message = '') => {
  doc.processingLog.push({ stage, status, message, timestamp: new Date() });
};

// ── Main pipeline ─────────────────────────────────────────────────────────────

/**
 * Processes a single document: extract → chunk → embed → persist.
 *
 * @param {string}  documentId
 * @param {object}  [opts]
 * @param {boolean} [opts.skipEmbedding=false] - persist chunks without embedding
 *                                               (useful for testing chunking logic)
 * @returns {Promise<import('../../models/Document.js').default>}
 */
export const processDocument = async (documentId, { skipEmbedding = false } = {}) => {
  const doc = await Document.findById(documentId);

  if (!doc) throw new Error(`Document not found: ${documentId}`);

  if (doc.processingStatus === 'processing') {
    throw new Error('Document is already being processed. Please wait.');
  }

  // ── Step 1: Mark as processing ────────────────────────────────────────────
  doc.processingStatus = 'processing';
  doc.processingError  = undefined;
  addLog(doc, 'pipeline', 'started', 'Starting PDF processing pipeline');
  await doc.save();

  try {
    // ── Step 2: Extract text ────────────────────────────────────────────────
    addLog(doc, 'text-extraction', 'started', `Reading: ${doc.filePath}`);
    await doc.save();

    const { pages, totalPages } = await extractPdfText(doc.filePath);
    doc.totalPages = totalPages;
    addLog(doc, 'text-extraction', 'completed', `Extracted ${totalPages} pages`);
    await doc.save();

    // ── Step 3: Chunk text ──────────────────────────────────────────────────
    addLog(doc, 'chunking', 'started', 'Splitting into chunks');
    await doc.save();

    const chunks = chunkPages(pages);

    if (chunks.length === 0) {
      throw new Error(
        'No text content could be extracted from this PDF. ' +
        'The file may be scanned or image-only.'
      );
    }

    addLog(doc, 'chunking', 'completed', `Created ${chunks.length} chunks`);
    await doc.save();

    // ── Step 4: Generate embeddings ─────────────────────────────────────────
    let embeddings = [];

    if (!skipEmbedding) {
      addLog(doc, 'embedding', 'started',
        `Generating embeddings with model: ${getModelName()}`);
      await doc.save();

      const texts = chunks.map((c) => c.content);

      embeddings = await embedBatch(texts, {
        batchSize:  config.EMBEDDING_BATCH_SIZE,
        onProgress: (done, total) => {
          console.log(`    [${doc._id}] Embedded ${done}/${total} chunks`);
        },
      });

      addLog(doc, 'embedding', 'completed',
        `Generated ${embeddings.length} embedding vectors (dim=${embeddings[0]?.length ?? 0})`);
      await doc.save();
    }

    // ── Step 5: Persist chunks ──────────────────────────────────────────────
    addLog(doc, 'persistence', 'started', `Saving ${chunks.length} chunks`);
    await doc.save();

    // Remove any stale chunks from a previous run
    await DocumentChunk.deleteByDocument(doc._id);

    const chunkDocs = chunks.map((chunk, i) => ({
      documentId: doc._id,
      content:    chunk.content,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      embedding:  embeddings[i] ?? [],
      isEmbedded: !skipEmbedding && embeddings[i]?.length > 0,
      metadata:   {
        ...chunk.metadata,
        embeddingModel: skipEmbedding ? null : getModelName(),
      },
    }));

    await DocumentChunk.insertMany(chunkDocs, { ordered: false });
    addLog(doc, 'persistence', 'completed', `${chunks.length} chunks saved`);

    // ── Step 6: Mark completed ──────────────────────────────────────────────
    doc.processingStatus = 'completed';
    doc.totalChunks      = chunks.length;
    addLog(doc, 'pipeline', 'completed', 'Pipeline finished successfully');
    await doc.save();

    return doc;

  } catch (err) {
    await DocumentChunk.deleteByDocument(doc._id).catch(() => {});

    doc.processingStatus = 'failed';
    doc.processingError  = err.message;
    doc.totalChunks      = 0;
    addLog(doc, 'pipeline', 'failed', err.message);
    await doc.save().catch(() => {});

    throw err;
  }
};

/**
 * Re-embeds all chunks for a document that already has text extracted.
 * Used when the embedding model changes — does NOT re-extract or re-chunk.
 *
 * @param {string} documentId
 * @returns {Promise<{ updated: number, modelName: string }>}
 */
export const reEmbedDocument = async (documentId) => {
  const chunks = await DocumentChunk.find({ documentId })
    .select('_id content')
    .lean();

  if (chunks.length === 0) {
    throw new Error('No chunks found. Run full reprocess first.');
  }

  const texts      = chunks.map((c) => c.content);
  const modelName  = getModelName();

  const embeddings = await embedBatch(texts, {
    batchSize:  config.EMBEDDING_BATCH_SIZE,
    onProgress: (done, total) =>
      console.log(`    [re-embed ${documentId}] ${done}/${total}`),
  });

  // Bulk-write updates — faster than N individual saves
  const bulkOps = chunks.map((chunk, i) => ({
    updateOne: {
      filter: { _id: chunk._id },
      update: {
        $set: {
          embedding:  embeddings[i],
          isEmbedded: true,
          'metadata.embeddingModel': modelName,
        },
      },
    },
  }));

  await DocumentChunk.bulkWrite(bulkOps, { ordered: false });

  return { updated: chunks.length, modelName };
};
