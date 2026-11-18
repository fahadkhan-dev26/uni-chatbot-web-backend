/**
 * testRag.js
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end RAG test: connects to MongoDB, embeds a set of test questions,
 * runs retrieval, and prints scored results with document provenance.
 *
 * Usage (from the Backend/ folder):
 *   node src/utils/testRag.js
 *
 * Prerequisites:
 *   1. MONGODB_URI is set in .env
 *   2. At least one document has been uploaded and fully processed
 *      (processingStatus = "completed", isEmbedded = true on its chunks)
 *
 * On first run the embedding model is downloaded (~90 MB).
 * Subsequent runs load from the local ./models/ cache.
 */

import connectDB, { disconnectDB } from '../config/db.js';
import { retrieveChunks, getEmbeddingStats } from '../services/rag/retrievalService.js';
import { getEmbedder, embedText } from '../services/embeddings/embeddingService.js';

// ── Test questions — replace with questions whose answers are in your PDF ─────
const TEST_QUESTIONS = [
  'What are the admission requirements?',
  'How much is the tuition fee per semester?',
  'What scholarships are available for international students?',
  'What academic programs does the university offer?',
  'What is the application deadline?',
  'What documents are required for enrollment?',
  'How do I apply for student accommodation?',
  'What are the English language requirements?',
];

// ── Helpers ───────────────────────────────────────────────────────────────────
const sep   = (t)   => console.log(`\n${'─'.repeat(56)}\n  ${t}\n${'─'.repeat(56)}`);
const ok    = (m)   => console.log(`  ✅  ${m}`);
const info  = (m)   => console.log(`  ℹ️   ${m}`);
const warn  = (m)   => console.log(`  ⚠️   ${m}`);

// ── Main ──────────────────────────────────────────────────────────────────────
const run = async () => {
  console.log('\n🔍  RAG Retrieval Test — University AI Chatbot\n');

  // ── 1. Connect ─────────────────────────────────────────────────────────────
  sep('1 / 4   Database Connection');
  try {
    await connectDB();
    ok('Connected to MongoDB Atlas');
  } catch (err) {
    console.error('❌  Connection failed:', err.message);
    process.exit(1);
  }

  // ── 2. Embedding stats ─────────────────────────────────────────────────────
  sep('2 / 4   Embedding Coverage');
  const stats = await getEmbeddingStats();
  info(`Model        : ${stats.modelName}`);
  info(`Total chunks : ${stats.total}`);
  info(`Embedded     : ${stats.embedded}`);
  info(`Pending      : ${stats.pending}`);

  if (stats.embedded === 0) {
    warn('No embedded chunks found!');
    warn('Upload a PDF via POST /api/documents/upload first,');
    warn('then run this test again.');
    await disconnectDB();
    process.exit(0);
  }

  // ── 3. Warm up the model ───────────────────────────────────────────────────
  sep('3 / 4   Model Warm-Up');
  console.log('  Loading embedding model (downloads on first run)…');
  await getEmbedder();
  ok('Model ready');

  // Quick sanity check: embed a known phrase and verify dimension
  const testVec = await embedText('university admission requirements');
  ok(`Test vector dimension: ${testVec.length} (expected 384)`);
  if (testVec.length !== 384) {
    warn('Unexpected dimension — check your EMBEDDING_MODEL setting');
  }

  // ── 4. Run retrieval for each test question ────────────────────────────────
  sep('4 / 4   Retrieval Results');

  for (const question of TEST_QUESTIONS) {
    console.log(`\n  ❓  "${question}"`);

    const results = await retrieveChunks(question, { topK: 3, minScore: 0.20 });

    if (results.length === 0) {
      warn('No results above threshold — question may not match uploaded documents');
      continue;
    }

    results.forEach((r, idx) => {
      console.log(`\n  [${idx + 1}] score=${r.score.toFixed(4)}  page=${r.pageNumber}`);
      console.log(`      Doc   : "${r.documentTitle}" (${r.category ?? 'no category'})`);
      if (r.academicYear) console.log(`      Year  : ${r.academicYear}`);
      console.log(`      Chunk : "${r.content.slice(0, 150).replace(/\n/g, ' ')}…"`);
    });
  }

  console.log('\n✅  RAG test complete.\n');
  await disconnectDB();
  process.exit(0);
};

run().catch(async (err) => {
  console.error('\n💥  Unexpected error:', err);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
