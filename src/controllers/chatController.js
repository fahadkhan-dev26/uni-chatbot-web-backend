/**
 * chatController.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HTTP layer for the student chat.
 *
 *   POST   /api/chat/message             ask a question (login optional)
 *   GET    /api/chat/history             list conversations (login or sessionId)
 *   GET    /api/chat/:id                 one conversation with messages
 *   DELETE /api/chat/:id                 soft-delete a conversation
 *
 * Legacy endpoints kept unchanged for existing clients:
 *   POST   /api/chat/ask                 authenticated ask
 *   GET    /api/chat/health              language-model status (authenticated)
 *   GET    /api/chat/sessions            list sessions (authenticated)
 *   GET    /api/chat/history/:sessionId  one session's messages (authenticated)
 *
 * All AI work lives in services/ai/answerService.js; conversation persistence
 * and ownership checks live in services/chat/conversationService.js. Sources
 * are NEVER taken from model output — they come from retrieval results whose
 * data was read from MongoDB.
 */

import { answerQuestion }        from '../services/ai/answerService.js';
import { checkLlmHealth }        from '../services/ai/llmService.js';
import { buildAttachmentContext } from '../services/chat/attachmentService.js';
import {
  normaliseSessionId,
  resolveConversation,
  appendExchange,
  getAccessibleConversation,
  listConversations,
  deactivateConversation,
  toConversationSummary,
  toConversationDetail,
} from '../services/chat/conversationService.js';
import { AppError }              from '../middleware/errorHandler.js';
import { Conversation }          from '../models/index.js';

// ── Shared validation ─────────────────────────────────────────────────────────

const MIN_QUESTION_LENGTH = 3;
const MAX_QUESTION_LENGTH = 1000;

/**
 * Validates and trims the student question.
 *
 * @param {unknown} raw
 * @returns {string}
 * @throws {AppError} 400
 */
const validateQuestion = (raw) => {
  if (!raw || typeof raw !== 'string') {
    throw new AppError('question is required and must be a string.', 400);
  }

  const question = raw.trim();

  if (question.length < MIN_QUESTION_LENGTH) {
    throw new AppError(
      `Question is too short (minimum ${MIN_QUESTION_LENGTH} characters).`,
      400
    );
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new AppError(
      `Question exceeds the ${MAX_QUESTION_LENGTH}-character limit.`,
      400
    );
  }

  return question;
};

/**
 * Builds the optional retrieval overrides from the request body.
 *
 * @param {{ topK?: unknown, minScore?: unknown, category?: unknown }} body
 * @returns {{ topK?: number, minScore?: number, category?: string }}
 */
const buildAnswerOptions = ({ topK, minScore, category }) => {
  const opts = {};

  if (typeof topK === 'number' && topK > 0) {
    opts.topK = Math.min(Math.floor(topK), 10);
  }
  if (typeof minScore === 'number' && minScore >= 0) {
    opts.minScore = Math.min(minScore, 1);
  }
  if (typeof category === 'string' && category.trim()) {
    opts.category = category.trim();
  }

  return opts;
};

/**
 * Identity of the caller: logged-in user id, otherwise the guest sessionId.
 *
 * @param {import('express').Request} req
 * @param {{ from?: 'body'|'query' }} [source]
 */
const getIdentity = (req, { from = 'query' } = {}) => ({
  userId:    req.user?._id ?? null,
  sessionId: normaliseSessionId(from === 'body' ? req.body?.sessionId : req.query?.sessionId),
});

// ── New endpoints ─────────────────────────────────────────────────────────────

/**
 * POST /api/chat/message
 * Public — login optional.
 *
 * Body (JSON or multipart/form-data):
 * {
 *   question:    string   (required, 3–1000 chars)
 *   sessionId?:  string   (guest session token; omit on the first turn)
 *   topK?:       number
 *   minScore?:   number
 *   category?:   string
 *   attachments?: File[]  (multipart field; PDF, TXT, MD, CSV, JSON, images)
 * }
 *
 * Response:
 * {
 *   success: true,
 *   answer: string,
 *   sources: [{ documentTitle, pageNumber, category, academicYear, score }],
 *   conversationId: string,
 *   sessionId: string,
 *   anonymous: boolean,
 *   meta: { model, retrievedChunks, usedFallback, reason, evalDurationMs, topScore, attachmentNotice }
 * }
 */
export const sendMessage = async (req, res, next) => {
  try {
    const question = validateQuestion(req.body?.question);
    const identity = getIdentity(req, { from: 'body' });

    // Resolve (or create) the conversation first: an unknown or foreign
    // sessionId must fail before we spend time on retrieval and inference.
    const conversation = await resolveConversation(identity);

    const attachments = await buildAttachmentContext(req.files ?? []);

    const { answer, sources, meta } = await answerQuestion(question, {
      ...buildAnswerOptions(req.body ?? {}),
      attachments,
    });

    await appendExchange(conversation, {
      question,
      answer,
      sources,
      attachments: attachments.meta,
    });

    res.status(200).json({
      success:        true,
      answer,
      sources,
      conversationId: conversation._id.toString(),
      sessionId:      conversation.sessionId,
      anonymous:      !conversation.userId,
      meta,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chat/history
 * Public — login optional.
 *
 * Query: page?, limit?, sessionId? (required for guests)
 *
 * Response: { success, page, totalPages, total, count, conversations: [...] }
 */
export const listHistory = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));

    const identity = getIdentity(req);
    const { conversations, total } = await listConversations(identity, { page, limit });

    res.status(200).json({
      success:       true,
      page,
      limit,
      totalPages:    Math.ceil(total / limit),
      total,
      count:         conversations.length,
      conversations: conversations.map(toConversationSummary),
    });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chat/:id
 * Public — login optional. `id` may be the conversation id or the sessionId.
 * Guests must pass ?sessionId=<their token>.
 *
 * Response: { success, conversation: { id, sessionId, title, messages, ... } }
 */
export const getConversation = async (req, res, next) => {
  try {
    const conversation = await getAccessibleConversation(
      req.params.id,
      getIdentity(req)
    );

    res.status(200).json({
      success:      true,
      conversation: toConversationDetail(conversation),
    });

  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/chat/:id
 * Public — login optional. Soft-deletes the conversation (isActive=false).
 *
 * Response: { success, message, id }
 */
export const deleteConversationHandler = async (req, res, next) => {
  try {
    const conversation = await getAccessibleConversation(
      req.params.id,
      getIdentity(req)
    );

    await deactivateConversation(conversation);

    res.status(200).json({
      success: true,
      message: 'Conversation deleted.',
      id:      conversation._id.toString(),
    });

  } catch (err) {
    next(err);
  }
};

// ── Legacy endpoints (unchanged contract) ─────────────────────────────────────

/**
 * POST /api/chat/ask
 * Authenticated (students + admins).
 * Kept for existing clients; new clients should use POST /api/chat/message.
 */
export const askQuestion = async (req, res, next) => {
  try {
    const question = validateQuestion(req.body?.question);
    const sessionId = normaliseSessionId(req.body?.sessionId);

    const conversation = await resolveConversation({
      userId: req.user._id,
      sessionId,
    });

    const { success, answer, sources, meta } = await answerQuestion(
      question,
      buildAnswerOptions(req.body ?? {})
    );

    await appendExchange(conversation, { question, answer, sources });

    res.status(200).json({
      success,
      answer,
      sources,
      sessionId: conversation.sessionId,
      meta,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chat/health
 * Authenticated.
 * Returns the status of the active language-model provider (Gemini or Ollama),
 * including whether the configured model is available to the API key.
 */
export const aiHealthCheck = async (req, res, next) => {
  try {
    const health = await checkLlmHealth();

    res.status(health.ok ? 200 : 503).json({
      success:  health.ok,
      provider: health,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chat/history/:sessionId
 * Authenticated.
 * Returns all messages in a conversation session for the logged-in user.
 */
export const getConversationHistory = async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    const conversation = await Conversation.findOne({
      sessionId,
      userId: req.user._id,
    }).select('-__v');

    if (!conversation) {
      return next(new AppError('Conversation not found.', 404));
    }

    res.status(200).json({
      success:      true,
      sessionId,
      title:        conversation.title,
      messageCount: conversation.messages.length,
      messages:     conversation.messages,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/chat/sessions
 * Authenticated.
 * Lists all conversation sessions for the logged-in user, newest first.
 */
export const listSessions = async (req, res, next) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10)  || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const skip  = (page - 1) * limit;

    const [sessions, total] = await Promise.all([
      Conversation.find({ userId: req.user._id, isActive: true })
        .select('sessionId title lastMessageAt createdAt')
        .sort({ lastMessageAt: -1 })
        .skip(skip)
        .limit(limit),
      Conversation.countDocuments({ userId: req.user._id, isActive: true }),
    ]);

    res.status(200).json({
      success: true,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      sessions,
    });
  } catch (err) {
    next(err);
  }
};
