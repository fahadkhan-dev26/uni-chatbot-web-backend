import fs from 'fs';
import path from 'path';

import Document      from '../models/Document.js';
import DocumentChunk from '../models/DocumentChunk.js';
import { AppError }  from '../middleware/errorHandler.js';
import { processDocument } from '../services/pdf/processingService.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Safely deletes a file from disk. Logs but does not throw on failure.
 * @param {string} filePath
 */
const deleteFileFromDisk = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn(`⚠️  Could not delete file "${filePath}": ${err.message}`);
  }
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /api/documents/upload
 * Admin only.
 * Accepts 1–5 PDF files in the `documents` field.
 * Each file also expects the form fields: title, category, academicYear (optional).
 *
 * When multiple files are uploaded, `title` and `category` can be:
 *   - a JSON array matching the files in order, OR
 *   - a single value applied to all files
 */
export const uploadDocuments = async (req, res, next) => {
  try {
    // Multer places validated files in req.files
    if (!req.files || req.files.length === 0) {
      return next(new AppError('No PDF files were uploaded.', 400));
    }

    const files = req.files;

    // ── Parse per-file metadata ─────────────────────────────────────────────
    const parseMeta = (field) => {
      const raw = req.body[field];
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [raw]; // treat as a single string
      }
    };

    const titles       = parseMeta('title');
    const categories   = parseMeta('category');
    const academicYears = parseMeta('academicYear');

    const getMeta = (arr, idx, fallback = '') =>
      (arr.length > 1 ? arr[idx] : arr[0]) ?? fallback;

    // ── Create Document records and kick off processing ─────────────────────
    const results = [];

    for (let i = 0; i < files.length; i++) {
      const file  = files[i];
      const title = getMeta(titles, i) || path.basename(file.originalname, '.pdf');

      // Check for duplicate filename from this admin
      const existing = await Document.findOne({
        filename:   file.originalname,
        uploadedBy: req.user._id,
      });

      if (existing) {
        // Don't process — delete the uploaded file and report the conflict
        deleteFileFromDisk(file.path);
        results.push({
          file:  file.originalname,
          error: `A document with this filename already exists (id: ${existing._id}). Delete it first or use the reprocess endpoint.`,
        });
        continue;
      }

      // Persist the document record
      const doc = await Document.create({
        title,
        filename:         file.originalname,
        filePath:         file.path,
        mimeType:         file.mimetype,
        fileSize:         file.size,
        category:         getMeta(categories, i, 'general-information'),
        academicYear:     getMeta(academicYears, i) || undefined,
        uploadedBy:       req.user._id,
        processingStatus: 'pending',
      });

      // Process the document (extract + chunk + persist chunks)
      // We run this inline here; replace with queue.add(doc._id) later.
      try {
        const processed = await processDocument(doc._id.toString());
        results.push({
          file:            file.originalname,
          documentId:      processed._id,
          title:           processed.title,
          totalPages:      processed.totalPages,
          totalChunks:     processed.totalChunks,
          processingStatus: processed.processingStatus,
        });
      } catch (procErr) {
        // Processing failed but the document record exists
        results.push({
          file:             file.originalname,
          documentId:       doc._id,
          processingStatus: 'failed',
          error:            procErr.message,
        });
      }
    }

    const allFailed  = results.every((r) => r.error);
    const statusCode = allFailed ? 422 : 201;

    res.status(statusCode).json({
      success: !allFailed,
      message: `${results.filter((r) => !r.error).length} of ${files.length} document(s) uploaded and processed.`,
      results,
    });

  } catch (err) {
    // Clean up any files that made it to disk on an unexpected crash
    if (req.files) {
      req.files.forEach((f) => deleteFileFromDisk(f.path));
    }
    next(err);
  }
};

/**
 * GET /api/documents
 * Public (authenticated users + admins).
 * Returns all completed documents.  Admins see all statuses.
 *
 * Query params:
 *   category    — filter by category slug
 *   academicYear — filter by year (e.g. 2024/2025)
 *   status      — admin only: filter by processingStatus
 *   page        — page number (default 1)
 *   limit       — results per page (default 20, max 100)
 */
export const getDocuments = async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === 'admin';
    const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit   = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip    = (page - 1) * limit;

    // ── Build filter ────────────────────────────────────────────────────────
    const filter = { isActive: true };

    // Students only see successfully processed documents
    if (!isAdmin) {
      filter.processingStatus = 'completed';
    } else if (req.query.status) {
      filter.processingStatus = req.query.status;
    }

    if (req.query.category)     filter.category     = req.query.category;
    if (req.query.academicYear) filter.academicYear = req.query.academicYear;

    const [documents, total] = await Promise.all([
      Document.find(filter)
        .select('-processingLog -processingError')
        .populate('uploadedBy', 'name email')
        .sort({ uploadedAt: -1 })
        .skip(skip)
        .limit(limit),
      Document.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      count:      documents.length,
      documents,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/documents/:id
 * Public (authenticated).  Admins also see processingLog.
 */
export const getDocumentById = async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === 'admin';

    const query = Document.findById(req.params.id)
      .populate('uploadedBy', 'name email');

    if (!isAdmin) {
      query.select('-processingLog -processingError');
    }

    const doc = await query;

    if (!doc || (!isAdmin && (!doc.isActive || doc.processingStatus !== 'completed'))) {
      return next(new AppError('Document not found.', 404));
    }

    // Chunk summary (count per page)
    const chunkSummary = await DocumentChunk.aggregate([
      { $match: { documentId: doc._id } },
      { $group: { _id: '$pageNumber', chunks: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({
      success: true,
      document: doc,
      chunkSummary,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/documents/:id
 * Admin only.
 * Deletes the document record, all its chunks, and the file on disk.
 */
export const deleteDocument = async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return next(new AppError('Document not found.', 404));
    }

    const { filePath, title } = doc;

    // 1. Delete all associated chunks
    const { deletedCount } = await DocumentChunk.deleteByDocument(doc._id);

    // 2. Delete the document record
    await Document.findByIdAndDelete(doc._id);

    // 3. Remove the file from disk
    deleteFileFromDisk(filePath);

    res.status(200).json({
      success: true,
      message: `Document "${title}" and its ${deletedCount} chunk(s) have been deleted.`,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/documents/:id/reprocess
 * Admin only.
 * Re-runs the extraction + chunking pipeline on an existing document.
 * Useful when:
 *   - A previous processing run failed.
 *   - The chunking strategy was updated.
 */
export const reprocessDocument = async (req, res, next) => {
  try {
    const doc = await Document.findById(req.params.id);

    if (!doc) {
      return next(new AppError('Document not found.', 404));
    }

    if (doc.processingStatus === 'processing') {
      return next(new AppError('Document is currently being processed. Please wait.', 409));
    }

    // Verify file still exists on disk
    if (!fs.existsSync(doc.filePath)) {
      return next(
        new AppError(
          `The original PDF file is missing from disk (${doc.filePath}). ` +
          'Please delete this document and re-upload the file.',
          422
        )
      );
    }

    const processed = await processDocument(doc._id.toString());

    res.status(200).json({
      success:  true,
      message:  `Document "${processed.title}" has been reprocessed successfully.`,
      document: {
        _id:              processed._id,
        title:            processed.title,
        processingStatus: processed.processingStatus,
        totalPages:       processed.totalPages,
        totalChunks:      processed.totalChunks,
      },
    });

  } catch (err) {
    next(err);
  }
};
