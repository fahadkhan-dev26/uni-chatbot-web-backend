import mongoose from 'mongoose';

const { Schema, model } = mongoose;

// ── Sub-schema: processing log entries ───────────────────────────────────────
const processingLogSchema = new Schema(
  {
    stage:     { type: String, required: true },   // e.g. "text-extraction"
    status:    { type: String, enum: ['started', 'completed', 'failed'], required: true },
    message:   { type: String },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

// ── Main schema ───────────────────────────────────────────────────────────────
const documentSchema = new Schema(
  {
    title: {
      type:      String,
      required:  [true, 'Document title is required'],
      trim:      true,
      maxlength: [200, 'Title cannot exceed 200 characters'],
    },

    // Original filename as uploaded (e.g. "CS101_Lecture1.pdf")
    filename: {
      type:     String,
      required: [true, 'Filename is required'],
      trim:     true,
    },

    // Path or object-storage key where the file is kept
    filePath: {
      type:     String,
      required: [true, 'File path is required'],
    },

    // MIME type — currently only PDF is processed
    mimeType: {
      type:    String,
      default: 'application/pdf',
    },

    fileSize: {
      type: Number,   // bytes
      min:  [0, 'File size cannot be negative'],
    },

    category: {
      type: String,
      enum: {
        values: [
          'admissions',
          'tuition-fees',
          'scholarships',
          'academic-programs',
          'academic-regulations',
          'student-handbook',
          'international-students',
          'application-deadlines',
          'general-information',
        ],
        message: '"{VALUE}" is not a supported document category',
      },
      default: 'general-information',
    },

    // e.g. "2024/2025"
    academicYear: {
      type:  String,
      trim:  true,
      match: [/^\d{4}\/\d{4}$/, 'Academic year must follow the pattern YYYY/YYYY'],
    },

    // Who uploaded the document
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref:  'User',           // relationship → User model
    },

    totalPages: {
      type: Number,
      min:  [0, 'Page count cannot be negative'],
      default: 0,
    },

    totalChunks: {
      type:    Number,
      min:     [0, 'Chunk count cannot be negative'],
      default: 0,
    },

    // Tracks where the document is in the ingestion pipeline
    processingStatus: {
      type: String,
      enum: {
        values: ['pending', 'processing', 'completed', 'failed'],
        message: '"{VALUE}" is not a valid processing status',
      },
      default: 'pending',
    },

    processingError: {
      type: String,     // last error message if status === 'failed'
    },

    processingLog: [processingLogSchema],

    // Convenience flag for soft-deletes / hiding from students
    isActive: {
      type:    Boolean,
      default: true,
    },

    uploadedAt: {
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

// Prevent the same physical file from being stored twice
documentSchema.index({ filename: 1, uploadedBy: 1 }, { unique: true });

// Common query patterns
documentSchema.index({ processingStatus: 1 });
documentSchema.index({ category: 1, academicYear: 1 });
documentSchema.index({ uploadedBy: 1 });
documentSchema.index({ isActive: 1, processingStatus: 1 });

// Full-text search on title (useful before vector search is added)
documentSchema.index({ title: 'text' });

// ── Virtual: formatted file size ──────────────────────────────────────────────
documentSchema.virtual('fileSizeFormatted').get(function () {
  if (!this.fileSize) return 'Unknown';
  const kb = this.fileSize / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
});

// ── Model ─────────────────────────────────────────────────────────────────────
const Document = model('Document', documentSchema);

export default Document;
