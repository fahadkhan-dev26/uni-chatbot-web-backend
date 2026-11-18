/**
 * testPdfPipeline.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests the complete PDF ingestion pipeline end-to-end against MongoDB Atlas.
 * Does NOT require a running Express server.
 *
 * Usage (from the Backend/ folder):
 *   node src/utils/testPdfPipeline.js <path-to-pdf>
 *
 * Example:
 *   node src/utils/testPdfPipeline.js "C:/Users/You/Downloads/prospectus.pdf"
 *
 * What it tests:
 *   1. pdfjs-dist text extraction  (page-by-page, preserving page numbers)
 *   2. Text chunker                (paragraph/sentence split with overlap)
 *   3. MongoDB save of Document    (with university category)
 *   4. MongoDB save of DocumentChunks (bulk insert)
 *   5. Retrieval of saved chunks
 *   6. Cleanup of test data
 */

import path    from 'path';
import fs      from 'fs';
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../config/db.js';
import { extractPdfText }          from '../services/pdf/pdfExtractor.js';
import { chunkPages }              from '../services/pdf/textChunker.js';
import Document                    from '../models/Document.js';
import DocumentChunk               from '../models/DocumentChunk.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const ok   = (msg)        => console.log(`  ✅  ${msg}`);
const fail = (msg, err)   => console.error(`  ❌  ${msg}:`, err?.message ?? err);
const info = (msg)        => console.log(`  ℹ️   ${msg}`);
const sep  = (title)      => { console.log(`\n${'─'.repeat(52)}\n  ${title}\n${'─'.repeat(52)}`); };

// ── Main ──────────────────────────────────────────────────────────────────────
const run = async () => {
  const pdfArg = process.argv[2];

  if (!pdfArg) {
    console.error('\n❌  Usage: node src/utils/testPdfPipeline.js <path-to-pdf>\n');
    process.exit(1);
  }

  const pdfPath = path.resolve(pdfArg);

  if (!fs.existsSync(pdfPath)) {
    console.error(`\n❌  File not found: ${pdfPath}\n`);
    process.exit(1);
  }

  const fileStat = fs.statSync(pdfPath);
  console.log('\n🧪  PDF Pipeline Test — University AI Chatbot');
  console.log(`    File : ${path.basename(pdfPath)}`);
  console.log(`    Size : ${(fileStat.size / 1024).toFixed(1)} KB`);

  // ── 1. Connect to MongoDB ──────────────────────────────────────────────────
  sep('1 / 5   MongoDB Connection');
  try {
    await connectDB();
    ok('Connected to Atlas');
  } catch (err) {
    fail('Connection failed', err);
    process.exit(1);
  }

  // ── 2. Extract text ────────────────────────────────────────────────────────
  sep('2 / 5   PDF Text Extraction');
  let pages, totalPages;
  try {
    ({ pages, totalPages } = await extractPdfText(pdfPath));
    ok(`Extracted ${totalPages} pages`);

    const nonEmpty = pages.filter((p) => p.charCount > 0);
    info(`Pages with text content: ${nonEmpty.length} / ${totalPages}`);

    if (nonEmpty.length === 0) {
      fail('Extraction', new Error('No text found — PDF may be image-only (scanned)'));
      await disconnectDB();
      process.exit(1);
    }

    // Show a snippet from page 1 and the last page
    const preview = (p) => p.text.slice(0, 120).replace(/\n/g, ' ');
    info(`Page  1 preview : "${preview(pages[0])}…"`);
    if (totalPages > 1) {
      info(`Page ${totalPages} preview : "${preview(pages[totalPages - 1])}…"`);
    }
  } catch (err) {
    fail('Text extraction failed', err);
    await disconnectDB();
    process.exit(1);
  }

  // ── 3. Chunk text ──────────────────────────────────────────────────────────
  sep('3 / 5   Text Chunking');
  let chunks;
  try {
    chunks = chunkPages(pages);
    ok(`Created ${chunks.length} chunks`);

    const tokens = chunks.map((c) => c.metadata.estimatedTokens);
    const minTok = Math.min(...tokens);
    const maxTok = Math.max(...tokens);
    const avgTok = Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length);

    info(`Token range   : ${minTok} – ${maxTok}  (avg ${avgTok})`);
    info(`Pages covered : ${new Set(chunks.map((c) => c.pageNumber)).size}`);

    // Show first chunk
    info(`Chunk 0 (page ${chunks[0].pageNumber}) :\n\n${chunks[0].content.slice(0, 300)}…\n`);

    if (chunks.length === 0) {
      fail('Chunking', new Error('No chunks produced'));
      await disconnectDB();
      process.exit(1);
    }
  } catch (err) {
    fail('Chunking failed', err);
    await disconnectDB();
    process.exit(1);
  }

  // ── 4. Save Document & chunks to MongoDB ──────────────────────────────────
  sep('4 / 5   MongoDB Persistence');
  let doc;
  try {
    // Create a test Document record (marked so we know it's a test)
    doc = await Document.create({
      title:            `[TEST] ${path.basename(pdfPath, '.pdf')}`,
      filename:         `__pipeline_test__${path.basename(pdfPath)}`,
      filePath:         pdfPath,
      mimeType:         'application/pdf',
      fileSize:         fileStat.size,
      category:         'general-information',
      processingStatus: 'processing',
      totalPages,
    });
    ok(`Document saved  id=${doc._id}`);

    // Bulk-insert chunks
    const chunkDocs = chunks.map((c) => ({
      documentId: doc._id,
      content:    c.content,
      pageNumber: c.pageNumber,
      chunkIndex: c.chunkIndex,
      isEmbedded: false,
      metadata:   c.metadata,
    }));

    await DocumentChunk.insertMany(chunkDocs, { ordered: false });
    ok(`${chunks.length} chunks saved to DocumentChunk collection`);

    // Update document to completed
    doc.processingStatus = 'completed';
    doc.totalChunks      = chunks.length;
    await doc.save();
    ok(`Document status updated → completed`);

  } catch (err) {
    fail('MongoDB persistence failed', err);
    if (doc) await Document.findByIdAndDelete(doc._id).catch(() => {});
    await disconnectDB();
    process.exit(1);
  }

  // ── 5. Retrieve & verify ───────────────────────────────────────────────────
  sep('5 / 5   Retrieval & Verification');
  try {
    const retrieved = await Document.findById(doc._id);
    ok(`Document retrieved  status=${retrieved.processingStatus}  chunks=${retrieved.totalChunks}`);

    const chunkCount = await DocumentChunk.countDocuments({ documentId: doc._id });
    ok(`Chunks retrieved from DB : ${chunkCount}`);

    if (chunkCount !== chunks.length) {
      fail('Count mismatch', new Error(`Expected ${chunks.length}, got ${chunkCount}`));
    }

    // Spot-check: fetch chunk from a specific page
    const midPage = Math.ceil(totalPages / 2);
    const sample  = await DocumentChunk.findOne({ documentId: doc._id, pageNumber: midPage });
    if (sample) {
      ok(`Sample chunk from page ${midPage} : "${sample.content.slice(0, 80)}…"`);
    }

    // Chunk distribution per page
    const dist = await DocumentChunk.aggregate([
      { $match: { documentId: doc._id } },
      { $group: { _id: '$pageNumber', count: { $sum: 1 } } },
      { $sort:  { _id: 1 } },
    ]);
    info(`Chunk distribution (first 5 pages):`);
    dist.slice(0, 5).forEach((d) => info(`  Page ${d._id}: ${d.count} chunk(s)`));

  } catch (err) {
    fail('Retrieval failed', err);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────────────');
  if (doc) {
    await DocumentChunk.deleteByDocument(doc._id).catch(() => {});
    await Document.findByIdAndDelete(doc._id).catch(() => {});
    ok('Test data cleaned up from MongoDB');
  }

  console.log('\n✅  Pipeline test complete.\n');
  await disconnectDB();
  process.exit(0);
};

run().catch(async (err) => {
  console.error('\n💥  Unexpected error:', err);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
