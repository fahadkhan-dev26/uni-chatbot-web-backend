/**
 * answerService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The single entry point for AI answers. Everything that turns a student
 * question into a cited answer lives here, so controllers stay thin and every
 * caller (chat endpoints, RAG test scripts) gets identical guarantees.
 *
 * Pipeline:
 *   1. Retrieve the most relevant chunks above the similarity threshold.
 *   2. No passages            -> fixed fallback, zero sources, Ollama untouched.
 *   3. Build system + user prompt from the passages.
 *   4. Ask the local Ollama model.
 *   5. Validate the answer and the CITATIONS line against the passages.
 *   6. Return { success, answer, sources, meta } — sources built from DB fields.
 *
 * meta.reason explains every fallback so the frontend can react:
 *   null                     — a grounded answer was produced
 *   'no-documents'           — no document has been processed yet
 *   'no-relevant-documents'  — documents exist, none matched the question
 *   'insufficient-context'   — model refused to answer from the passages
 *   'ollama-unavailable'     — local model unreachable / timed out
 *
 * Failure behaviour: if Ollama is down or times out, the student still gets a
 * valid, honest response (the fallback answer) instead of a 500.
 */

import { retrieveChunks } from '../rag/retrievalService.js';
import { chatCompletion } from './ollamaService.js';
import {
  SYSTEM_PROMPT,
  VISION_SYSTEM_PROMPT,
  FALLBACK_ANSWER,
  NO_DOCUMENTS_ANSWER,
  buildUserPrompt,
  processAnswer,
  buildSources,
} from './promptBuilder.js';
import DocumentChunk from '../../models/DocumentChunk.js';
import config from '../../config/env.js';

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Answers a student question from the university document corpus.
 *
 * @param {string} question
 * @param {object} [opts]
 * @param {number} [opts.topK]     - passages to retrieve (default: RAG_TOP_K)
 * @param {number} [opts.minScore] - similarity floor (default: RAG_MIN_SCORE)
 * @param {string} [opts.category] - restrict retrieval to one document category
 * @param {{ passages?: object[], images?: {name: string, data: string}[], notice?: string|null }} [opts.attachments]
 *   Per-message files already extracted by services/chat/attachmentService.js.
 * @returns {Promise<{
 *   success: true,
 *   answer: string,
 *   sources: Array<{ documentTitle: string, pageNumber: number, category: string|null, academicYear: string|null, score: number }>,
 *   meta: { model: string, retrievedChunks: number, usedFallback: boolean, reason: string|null, evalDurationMs: number|null, topScore: number|null, attachmentNotice: string|null, ollamaError?: string }
 * }>}
 */
export const answerQuestion = async (question, opts = {}) => {
  const retrievalOpts = {
    topK:     opts.topK     ?? config.RAG_TOP_K,
    minScore: opts.minScore ?? config.RAG_MIN_SCORE,
  };
  if (opts.category) retrievalOpts.category = opts.category;

  const attachmentPassages = opts.attachments?.passages ?? [];
  const attachmentImages   = opts.attachments?.images ?? [];
  const attachmentNotice   = opts.attachments?.notice ?? null;

  const retrieved  = await retrieveChunks(question, retrievalOpts);
  const chunks     = [...attachmentPassages, ...retrieved];
  const visionModel = attachmentImages.length > 0 ? config.OLLAMA_VISION_MODEL : '';

  // ── Nothing relevant enough — never ask the model ──────────────────────────
  if (chunks.length === 0 && !visionModel) {
    const hasDocuments = Boolean(await DocumentChunk.exists({ isEmbedded: true }));

    return {
      success: true,
      answer:  hasDocuments ? FALLBACK_ANSWER : NO_DOCUMENTS_ANSWER,
      sources: [],
      meta: {
        model:            config.OLLAMA_MODEL,
        retrievedChunks:  0,
        usedFallback:     true,
        reason:           hasDocuments ? 'no-relevant-documents' : 'no-documents',
        evalDurationMs:   null,
        topScore:         null,
        attachmentNotice,
      },
    };
  }

  // ── Ask Ollama ────────────────────────────────────────────────────────────
  let completion;
  try {
    completion = await chatCompletion(
      {
        system: visionModel ? VISION_SYSTEM_PROMPT : SYSTEM_PROMPT,
        user:   buildUserPrompt(question, chunks, {
          imageCount: visionModel ? attachmentImages.length : 0,
        }),
        images: visionModel ? attachmentImages.map((image) => image.data) : undefined,
      },
      visionModel ? { model: visionModel } : undefined
    );
  } catch (err) {
    console.error('⚠️  Ollama error:', err.message);
    return {
      success: true,
      answer:  FALLBACK_ANSWER,
      sources: [],
      meta: {
        model:            visionModel || config.OLLAMA_MODEL,
        retrievedChunks:  chunks.length,
        usedFallback:     true,
        reason:           'ollama-unavailable',
        evalDurationMs:   null,
        topScore:         chunks[0]?.score ?? null,
        attachmentNotice,
        ollamaError:      err.message,
      },
    };
  }

  // ── Validate the answer and its citations ─────────────────────────────────
  const processed = processAnswer(completion.text, chunks.length);
  const sources   = buildSources(chunks, processed);

  return {
    success: true,
    answer:  processed.answer,
    sources,
    meta: {
      model:            completion.model,
      retrievedChunks:  chunks.length,
      usedFallback:     processed.usedFallback,
      reason:           processed.usedFallback ? 'insufficient-context' : null,
      evalDurationMs:   completion.evalDurationMs,
      topScore:         chunks[0]?.score ?? null,
      attachmentNotice,
    },
  };
};
