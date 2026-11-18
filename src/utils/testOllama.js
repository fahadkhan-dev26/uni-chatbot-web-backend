/**
 * testOllama.js
 * ─────────────────────────────────────────────────────────────────────────────
 * End-to-end check of the RAG → Ollama → structured-answer pipeline.
 * Does NOT require a running Express server.
 *
 * Usage (from the Backend/ folder):
 *   npm run test:ollama
 *   # or: node src/utils/testOllama.js "When do applications close?"
 *
 * Prerequisites:
 *   1. MONGODB_URI set in .env  (Atlas connected)
 *   2. At least one document uploaded, processed, and embedded
 *   3. Ollama running locally: ollama serve
 *   4. Model downloaded: ollama pull llama3.2
 */

import connectDB, { disconnectDB } from '../config/db.js';
import { checkOllamaHealth }       from '../services/ai/ollamaService.js';
import { answerQuestion }          from '../services/ai/answerService.js';
import config                      from '../config/env.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const sep  = (t) => console.log(`\n${'─'.repeat(56)}\n  ${t}\n${'─'.repeat(56)}`);
const ok   = (m) => console.log(`  ✅  ${m}`);
const fail = (m, e) => console.error(`  ❌  ${m}:`, e?.message ?? e);
const info = (m) => console.log(`  ℹ️   ${m}`);

// ── Default questions — pass your own as CLI arguments ────────────────────────
const DEFAULT_QUESTIONS = [
  'What are the admission requirements for undergraduate programs?',
  'How much does tuition cost per semester?',
  'What is the deadline for submitting applications?',
];

const questions = process.argv.slice(2);
if (questions.length === 0) questions.push(...DEFAULT_QUESTIONS);

// ── Main ──────────────────────────────────────────────────────────────────────
const run = async () => {
  console.log('\n🤖  Ollama + RAG Integration Test — University AI Chatbot\n');

  sep('1 / 3   Database Connection');
  try {
    await connectDB();
    ok('Connected to MongoDB');
  } catch (err) {
    fail('Connection failed', err);
    process.exit(1);
  }

  sep('2 / 3   Ollama Health Check');
  const health = await checkOllamaHealth();

  if (!health.ok) {
    fail('Ollama unreachable', { message: health.error });
    console.log('\n  ⚡  Install Ollama, then run:');
    console.log('         ollama serve');
    console.log(`         ollama pull ${config.OLLAMA_MODEL}\n`);
    await disconnectDB();
    process.exit(1);
  }

  ok(`Ollama v${health.version} is running at ${config.OLLAMA_BASE_URL}`);
  info(`Configured model : ${health.configuredModel}`);
  info(`Available models : ${health.models.join(', ') || '(none)'}`);
  info(`Context window   : ${config.OLLAMA_NUM_CTX} tokens`);
  info(`RAG threshold    : ${config.RAG_MIN_SCORE} (top ${config.RAG_TOP_K})`);

  if (!health.modelAvailable) {
    console.log(`\n  ⚡  Model "${health.configuredModel}" is not downloaded yet.`);
    console.log(`     Run: ollama pull ${health.configuredModel}\n`);
    await disconnectDB();
    process.exit(1);
  }

  sep('3 / 3   Structured Answers');

  let fallbacks = 0;

  for (let i = 0; i < questions.length; i++) {
    console.log(`\n  ❓  [${i + 1}/${questions.length}] "${questions[i]}"`);

    try {
      const started = Date.now();
      const result  = await answerQuestion(questions[i]);
      const ms      = Date.now() - started;

      console.log(JSON.stringify(result, null, 2));

      if (result.meta.usedFallback) {
        fallbacks++;
        info(`Fallback after ${ms} ms (retrieved ${result.meta.retrievedChunks} chunk(s), top score ${result.meta.topScore ?? 'n/a'})`);
      } else {
        ok(`${ms} ms • ${result.sources.length} source(s) • top score ${result.meta.topScore}`);
      }
    } catch (err) {
      fail(`Pipeline error for question ${i + 1}`, err);
    }
  }

  sep('Summary');
  info(`${questions.length - fallbacks}/${questions.length} answered from documents`);

  if (fallbacks === questions.length) {
    console.log('  ⚠️   Every question fell back. Either the PDF lacks these answers,');
    console.log('      chunks are not embedded, or RAG_MIN_SCORE is too strict.\n');
  }

  console.log('\n✅  Ollama integration test complete.\n');
  await disconnectDB();
  process.exit(0);
};

run().catch(async (err) => {
  console.error('\n💥  Unexpected error:', err);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
