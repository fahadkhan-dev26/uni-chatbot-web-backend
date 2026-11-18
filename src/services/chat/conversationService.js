/**
 * conversationService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Conversation persistence and access control for the chat API.
 *
 * An identity is either:
 *   • an authenticated user          (userId)
 *   • an anonymous browser session   (sessionId — an opaque random token the
 *                                     client stores, e.g. in localStorage)
 *
 * An anonymous sessionId is the only thing protecting a guest's chats, so it
 * is validated, must be unguessable in practice, and is checked on every read
 * or write. A logged-in user may also claim a guest conversation by presenting
 * its sessionId (guest → login upgrade).
 */

import mongoose from 'mongoose';
import { Conversation } from '../../models/index.js';
import { AppError } from '../../middleware/errorHandler.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Validates a client-supplied sessionId. Rejects empty, oversized, or
 * path-like values that could confuse routing or logs.
 *
 * @param {unknown} sessionId
 * @param {string}  field - where it came from, for the error message
 * @returns {string|null}
 */
export const normaliseSessionId = (sessionId, field = 'sessionId') => {
  if (sessionId === undefined || sessionId === null || sessionId === '') return null;

  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError(
      `${field} must be 10–128 characters using letters, digits, "-" or "_".`,
      400
    );
  }

  return sessionId;
};

/**
 * True when this request identity may access the conversation.
 *
 * @param {import('../models/Conversation.js').default} conversation
 * @param {{ userId: string|null, sessionId: string|null }} identity
 * @returns {boolean}
 */
const canAccess = (conversation, { userId, sessionId }) => {
  const conversationUserId = conversation.userId ? conversation.userId.toString() : null;

  // Logged-in owner
  if (userId && conversationUserId === userId.toString()) return true;

  // Guest conversation, sessionId presented (owner after login, or the guest)
  if (conversationUserId === null && sessionId && conversation.sessionId === sessionId) return true;

  return false;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Finds the conversation for the next message, creating it when this is the
 * first turn. Throws 403 if the sessionId belongs to someone else.
 *
 * @param {{ userId?: string|null, sessionId?: string|null }} identity
 * @returns {Promise<import('../models/Conversation.js').default>}
 */
export const resolveConversation = async ({ userId = null, sessionId = null }) => {
  if (!sessionId) {
    return Conversation.create(userId ? { userId } : {});
  }

  const existing = await Conversation.findOne({ sessionId });

  if (existing) {
    if (!canAccess(existing, { userId, sessionId })) {
      throw new AppError('This chat session belongs to another account.', 403);
    }
    if (!existing.isActive) {
      throw new AppError('This conversation has been deleted. Start a new one.', 404);
    }

    // Guest conversation + now logged in: attach it to the account on save
    if (userId && !existing.userId) {
      existing.userId = userId;
    }

    return existing;
  }

  // First turn of a brand-new session
  return Conversation.create(userId ? { userId, sessionId } : { sessionId });
};

/**
 * Appends the student question and the assistant answer to the conversation.
 *
 * Only documentTitle, pageNumber and score are persisted — all read from the
 * retrieval results, never from model output. Attachment metadata (name, type,
 * size) is stored with the user message; file contents are never persisted.
 *
 * @param {import('../models/Conversation.js').default} conversation
 * @param {{ question: string, answer: string, sources?: object[], attachments?: object[] }} exchange
 * @returns {Promise<import('../models/Conversation.js').default>}
 */
export const appendExchange = async (
  conversation,
  { question, answer, sources = [], attachments = [] }
) => {
  conversation.messages.push({
    role:    'user',
    content: question,
    sources: [],
    attachments: attachments.map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
    })),
  });

  conversation.messages.push({
    role:    'assistant',
    content: answer,
    sources: sources.map((s) => ({
      documentTitle: s.documentTitle,
      pageNumber:    s.pageNumber,
      score:         s.score,
    })),
  });

  await conversation.save();
  return conversation;
};

/**
 * Loads one conversation by Mongo id or sessionId and enforces access.
 *
 * @param {string} id
 * @param {{ userId?: string|null, sessionId?: string|null }} identity
 * @returns {Promise<import('../models/Conversation.js').default>}
 * @throws {AppError} 404 when missing/deleted, 403 when not the caller's
 */
export const getAccessibleConversation = async (id, identity) => {
  const conversation = mongoose.isValidObjectId(id)
    ? await Conversation.findById(id)
    : await Conversation.findOne({ sessionId: id });

  if (!conversation || !conversation.isActive) {
    throw new AppError('Conversation not found.', 404);
  }

  if (!canAccess(conversation, identity)) {
    throw new AppError(
      identity.userId || identity.sessionId
        ? 'You do not have access to this conversation.'
        : 'sessionId is required to access this conversation.',
      403
    );
  }

  return conversation;
};

/**
 * Lists active conversations for the identity, newest first.
 *
 * @param {{ userId?: string|null, sessionId?: string|null }} identity
 * @param {{ page?: number, limit?: number }} [paging]
 * @returns {Promise<{ conversations: object[], total: number }>}
 */
export const listConversations = async ({ userId = null, sessionId = null }, { page = 1, limit = 20 } = {}) => {
  const filter = { isActive: true, ...(userId ? { userId } : { userId: null }) };

  // Guests only ever see the session they present
  if (!userId) {
    if (!sessionId) {
      throw new AppError(
        'Provide sessionId (or log in) to see your conversations.',
        400
      );
    }
    filter.sessionId = sessionId;
  }

  const [conversations, total] = await Promise.all([
    Conversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Conversation.countDocuments(filter),
  ]);

  return { conversations, total };
};

/**
 * Soft-deletes a conversation (isActive = false).
 *
 * @param {import('../models/Conversation.js').default} conversation
 * @returns {Promise<void>}
 */
export const deactivateConversation = async (conversation) => {
  conversation.isActive = false;
  await conversation.save();
};

// ── Serialisers (React-friendly, camelCase, ISO dates) ───────────────────────

const iso = (date) => (date ? new Date(date).toISOString() : null);

/**
 * @param {import('../models/Conversation.js').default} c
 */
export const toConversationSummary = (c) => ({
  id:            c._id.toString(),
  sessionId:     c.sessionId,
  title:         c.title,
  anonymous:     !c.userId,
  messageCount:  c.messages.length,
  lastMessageAt: iso(c.lastMessageAt),
  createdAt:     iso(c.createdAt),
  updatedAt:     iso(c.updatedAt),
});

/**
 * @param {import('../models/Conversation.js').default} c
 */
export const toConversationDetail = (c) => ({
  ...toConversationSummary(c),
  messages: c.messages.map((m) => ({
    id:        m._id.toString(),
    role:      m.role,
    content:   m.content,
    sources:   (m.sources ?? []).map((s) => ({
      documentTitle: s.documentTitle,
      pageNumber:    s.pageNumber,
      score:         s.score ?? null,
    })),
    attachments: (m.attachments ?? []).map((a) => ({
      name: a.name,
      type: a.type,
      size: a.size,
    })),
    createdAt: iso(m.createdAt),
  })),
});
