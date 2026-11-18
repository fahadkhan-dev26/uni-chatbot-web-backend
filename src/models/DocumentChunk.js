import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// ── Schema ────────────────────────────────────────────────────────────────────
const documentChunkSchema = new Schema(
  {
    // Parent document — required relationship
    documentId: {
      type:     Schema.Types.ObjectId,
      ref:      'Document',     // relationship → Document model
      required: [true, 'documentId is required'],
      index:    true,           // heavily queried field
    },

    // The raw extracted text for this chunk
    content: {
      type:      String,
      required:  [true, 'Chunk content is required'],
      minlength: [1, 'Content cannot be empty'],
    },

    // Vector embedding produced by the embedding service (populated later)
    // Stored as a plain array of floats — length depends on the model used
    // (e.g. 384 for all-MiniLM-L6-v2, 1536 for text-embedding-ada-002)
    embedding: {
      type:    [Number],
      default: [],
      // No hard length validation here so we can swap embedding models freely
    },

    // Source page in the original PDF (1-based)
    pageNumber: {
      type:     Number,
      required: [true, 'pageNumber is required'],
      min:      [1, 'Page number must be at least 1'],
    },

    // Position of this chunk within its page (0-based)
    chunkIndex: {
      type:     Number,
      required: [true, 'chunkIndex is required'],
      min:      [0, 'chunkIndex cannot be negative'],
    },

    // Whether an embedding has been generated for this chunk
    isEmbedded: {
      type:    Boolean,
      default: false,
    },

    // Arbitrary key/value bag for the RAG pipeline
    // (token count, section heading, overlap info, etc.)
    metadata: {
      type:    Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────

// Enforce that each (document, page, chunkIndex) triplet is unique
documentChunkSchema.index(
  { documentId: 1, pageNumber: 1, chunkIndex: 1 },
  { unique: true }
);

// Quickly fetch all un-embedded chunks for the embedding worker
documentChunkSchema.index({ isEmbedded: 1, documentId: 1 });

// Full-text search on content — useful as a fallback to vector search
documentChunkSchema.index({ content: 'text' });

// ── Static helper: delete all chunks belonging to a document ─────────────────
documentChunkSchema.statics.deleteByDocument = function (documentId) {
  return this.deleteMany({ documentId });
};

// ── Model ─────────────────────────────────────────────────────────────────────
const DocumentChunk = model('DocumentChunk', documentChunkSchema);

export default DocumentChunk;
