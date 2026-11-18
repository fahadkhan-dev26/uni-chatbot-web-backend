import mongoose from 'mongoose';
import { randomUUID } from 'crypto';   // Node built-in — no extra dependency

const { Schema, model } = mongoose;

// ── Sub-schema: a source citation attached to an AI message ──────────────────
const sourceSchema = new Schema(
  {
    documentId: {
      type: Schema.Types.ObjectId,
      ref:  'Document',
    },
    chunkId: {
      type: Schema.Types.ObjectId,
      ref:  'DocumentChunk',
    },
    documentTitle: { type: String },
    pageNumber:    { type: Number },
    // Relevance score returned by the vector search (0 – 1)
    score:         { type: Number, min: 0, max: 1 },
    // A short excerpt from the matching chunk shown in the UI
    excerpt:       { type: String, maxlength: 500 },
  },
  { _id: false }
);

// ── Sub-schema: a file the student attached to a user message ────────────────
// Only metadata is stored — file contents live for a single request.
const attachmentSchema = new Schema(
  {
    name: { type: String, maxlength: 200 },
    type: { type: String, maxlength: 120 },
    size: { type: Number, min: 0 },
  },
  { _id: false }
);

// ── Sub-schema: a single chat message ────────────────────────────────────────
const messageSchema = new Schema(
  {
    role: {
      type: String,
      enum: {
        values:  ['user', 'assistant', 'system'],
        message: 'Role must be "user", "assistant", or "system"',
      },
      required: [true, 'Message role is required'],
    },

    content: {
      type:      String,
      required:  [true, 'Message content is required'],
      maxlength: [20000, 'Message content cannot exceed 20 000 characters'],
    },

    // Only assistant messages carry sources
    sources: {
      type:    [sourceSchema],
      default: [],
    },

    // Only user messages carry attachments
    attachments: {
      type:    [attachmentSchema],
      default: [],
    },

    createdAt: {
      type:    Date,
      default: Date.now,
    },
  },
  { _id: true }   // keep _id on messages so individual messages can be referenced
);

// ── Main schema ───────────────────────────────────────────────────────────────
const conversationSchema = new Schema(
  {
    // Browser / anonymous sessions get a UUID; authenticated users get a userId
    sessionId: {
      type:     String,
      required: [true, 'sessionId is required'],
      default:  randomUUID,
      index:    true,
    },

    // Optional link to an authenticated user
    userId: {
      type:  Schema.Types.ObjectId,
      ref:   'User',
      index: true,
    },

    // Auto-generated from the first user message if not provided
    title: {
      type:      String,
      trim:      true,
      maxlength: [150, 'Conversation title cannot exceed 150 characters'],
      default:   'New Conversation',
    },

    messages: {
      type:    [messageSchema],
      default: [],
    },

    // Track whether the conversation is still live
    isActive: {
      type:    Boolean,
      default: true,
    },

    // Convenience field — updated every time a message is appended
    lastMessageAt: {
      type:    Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// Most common lookup: all conversations for a user, newest first
conversationSchema.index({ userId: 1, lastMessageAt: -1 });

// Useful for session-based (unauthenticated) lookups
conversationSchema.index({ sessionId: 1, lastMessageAt: -1 });

// ── Pre-save hook: sync lastMessageAt and auto-title ─────────────────────────
// Mongoose 9 no longer passes a `next` callback to document middleware.
conversationSchema.pre('save', function () {
  if (this.messages.length > 0) {
    const last = this.messages[this.messages.length - 1];
    this.lastMessageAt = last.createdAt || new Date();

    // Auto-title from the first user message (truncated to 80 chars)
    if (this.title === 'New Conversation') {
      const firstUser = this.messages.find((m) => m.role === 'user');
      if (firstUser) {
        this.title = firstUser.content.slice(0, 80).trim();
      }
    }
  }
});

// ── Instance method: append a message and persist ─────────────────────────────
conversationSchema.methods.addMessage = async function ({ role, content, sources = [] }) {
  this.messages.push({ role, content, sources });
  return this.save();
};

// ── Model ─────────────────────────────────────────────────────────────────────
const Conversation = model('Conversation', conversationSchema);

export default Conversation;
