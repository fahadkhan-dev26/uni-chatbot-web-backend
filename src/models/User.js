import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const { Schema, model } = mongoose;

// ── Schema ────────────────────────────────────────────────────────────────────
const userSchema = new Schema(
  {
    name: {
      type:     String,
      required: [true, 'Name is required'],
      trim:     true,
      minlength: [2,  'Name must be at least 2 characters'],
      maxlength: [80, 'Name cannot exceed 80 characters'],
    },

    email: {
      type:      String,
      required:  [true, 'Email is required'],
      unique:    true,          // creates a unique index automatically
      lowercase: true,
      trim:      true,
      match: [
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
        'Please provide a valid email address',
      ],
    },

    password: {
      type:      String,
      required:  [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select:    false,         // never returned in queries by default
    },

    role: {
      type:    String,
      enum:    {
        values:  ['student', 'admin'],
        message: 'Role must be either "student" or "admin"',
      },
      default: 'student',
    },

    isActive: {
      type:    Boolean,
      default: true,
    },

    lastLogin: {
      type: Date,
    },
  },
  {
    timestamps: true,           // adds createdAt and updatedAt automatically
    versionKey: false,
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// email already has a unique index from the schema definition above.
// Compound index to quickly filter active users by role.
userSchema.index({ role: 1, isActive: 1 });

// ── Pre-save hook: hash password before writing to DB ─────────────────────────
// Async middleware in Mongoose 9 receives no `next` callback — return instead.
userSchema.pre('save', async function () {
  // Only re-hash if the password field was actually modified
  if (!this.isModified('password')) return;

  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
});

// ── Instance method: compare a plain-text password against the stored hash ────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ── Instance method: safe public representation (no password) ─────────────────
userSchema.methods.toPublicJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

// ── Model ─────────────────────────────────────────────────────────────────────
const User = model('User', userSchema);

export default User;
