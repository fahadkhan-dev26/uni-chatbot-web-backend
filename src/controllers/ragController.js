import { retrieveChunks, getEmbeddingStats } from '../services/rag/retrievalService.js';
import { reEmbedDocument }                   from '../services/pdf/processingService.js';
import { AppError }                          from '../middleware/errorHandler.js';
import Document                              from '../models/Document.js';
import DocumentChunk                         from '../models/DocumentChunk.js';

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /api/rag/query
 * Authenticated (students + admins).
 *
 * Body:
 *   { question: string, topK?: number, minScore?: number,
 *     category?: string, documentId?: string }
 *
 * Returns the top-K most relevant chunks with document metadata.
 * Sources are built from verified DB fields only — never fabricated.
 */
export const queryRag = async (req, res, next) => {
  try {
    const { question, topK, minScore, category, documentId } = req.body;

    // ── Validate input ─────────────────────────────────────────────────────
    if (!question || typeof question !== 'string') {
      return next(new AppError('question is required and must be a string.', 400));
    }

    const trimmed = question.trim();
    if (trimmed.length < 3) {
      return next(new AppError('Question is too short.', 400));
    }
    if (trimmed.length > 1000) {
      return next(new AppError('Question exceeds the maximum length of 1000 characters.', 400));
    }

    // ── Build options ──────────────────────────────────────────────────────
    const opts = {};
    if (typeof topK     === 'number' && topK     > 0)  opts.topK     = Math.min(topK, 20);
    if (typeof minScore === 'number' && minScore >= 0)  opts.minScore = Math.min(minScore, 1);
    if (category)   opts.category   = category;
    if (documentId) opts.documentId = documentId;

    // ── Retrieve ───────────────────────────────────────────────────────────
    const results = await retrieveChunks(trimmed, opts);

    if (results.length === 0) {
      return res.status(200).json({
        success:  true,
        question: trimmed,
        message:  'No relevant content found in the university documents for this question.',
        results:  [],
      });
    }

    res.status(200).json({
      success:  true,
      question: trimmed,
      count:    results.length,
      results,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/rag/status
 * Admin only.
 * Returns embedding coverage stats across the DocumentChunk collection.
 */
export const getStatus = async (req, res, next) => {
  try {
    const stats = await getEmbeddingStats();

    // Per-document embedding progress
    const docStats = await DocumentChunk.aggregate([
      {
        $group: {
          _id:      '$documentId',
          total:    { $sum: 1 },
          embedded: { $sum: { $cond: ['$isEmbedded', 1, 0] } },
        },
      },
    ]);

    // Look up document titles for the per-doc breakdown
    const docIds   = docStats.map((d) => d._id);
    const docs     = await Document.find({ _id: { $in: docIds } })
                                   .select('title category processingStatus')
                                   .lean();
    const docTitles = Object.fromEntries(docs.map((d) => [d._id.toString(), d]));

    const perDocument = docStats.map((d) => {
      const meta = docTitles[d._id?.toString()] ?? {};
      return {
        documentId:       d._id,
        title:            meta.title            ?? 'Unknown',
        category:         meta.category         ?? null,
        processingStatus: meta.processingStatus ?? null,
        totalChunks:      d.total,
        embeddedChunks:   d.embedded,
        pendingChunks:    d.total - d.embedded,
        complete:         d.total === d.embedded,
      };
    });

    res.status(200).json({
      success: true,
      global:  stats,
      perDocument,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/rag/embed/:documentId
 * Admin only.
 * Re-generates embeddings for all chunks of a document without re-extracting
 * or re-chunking.  Use after changing the EMBEDDING_MODEL.
 */
export const reEmbedDocumentHandler = async (req, res, next) => {
  try {
    const { documentId } = req.params;

    const doc = await Document.findById(documentId);
    if (!doc) {
      return next(new AppError('Document not found.', 404));
    }

    console.log(`🔄  Re-embedding document "${doc.title}" (${documentId})`);

    const result = await reEmbedDocument(documentId);

    res.status(200).json({
      success:    true,
      message:    `Re-embedded ${result.updated} chunks for "${doc.title}".`,
      documentId,
      updated:    result.updated,
      modelName:  result.modelName,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/rag/embed-all
 * Admin only.
 * Re-generates embeddings for every document that has un-embedded chunks.
 * Useful after a model change or if embedding was skipped during upload.
 */
export const reEmbedAll = async (req, res, next) => {
  try {
    // Find documents that have at least one un-embedded chunk
    const pendingDocIds = await DocumentChunk.distinct('documentId', {
      isEmbedded: false,
    });

    if (pendingDocIds.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'All chunks are already embedded. Nothing to do.',
        processed: 0,
      });
    }

    const summary = [];

    for (const docId of pendingDocIds) {
      try {
        const result = await reEmbedDocument(docId.toString());
        summary.push({ documentId: docId, updated: result.updated, error: null });
      } catch (err) {
        console.error(`❌  Re-embed failed for ${docId}:`, err.message);
        summary.push({ documentId: docId, updated: 0, error: err.message });
      }
    }

    const succeeded = summary.filter((s) => !s.error).length;

    res.status(200).json({
      success:   true,
      message:   `Re-embedding complete. ${succeeded}/${pendingDocIds.length} documents updated.`,
      processed: pendingDocIds.length,
      summary,
    });

  } catch (err) {
    next(err);
  }
};
