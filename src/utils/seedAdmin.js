/**
 * seedAdmin.js
 * ─────────────────────────────────────────────────────────────────────────────
 * One-shot script to create the first administrator account.
 * Safe to run multiple times — it will NOT overwrite an existing admin.
 *
 * Usage (from the Backend/ folder):
 *   node src/utils/seedAdmin.js
 *
 * Credentials are read exclusively from environment variables — nothing is
 * hardcoded.  Set these in your .env before running:
 *
 *   ADMIN_NAME=Your Name
 *   ADMIN_EMAIL=admin@university.edu
 *   ADMIN_PASSWORD=YourStrongPassword123!
 *
 * Password requirements enforced by the User model:
 *   • Minimum 8 characters
 */

import connectDB, { disconnectDB } from '../config/db.js';
import User                        from '../models/User.js';

const run = async () => {
  console.log('\n🌱  Admin Seeder — University AI Chatbot');
  console.log('─────────────────────────────────────────────\n');

  // ── 1. Read credentials from environment ──────────────────────────────────
  const name     = process.env.ADMIN_NAME?.trim();
  const email    = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  const missing = [];
  if (!name)     missing.push('ADMIN_NAME');
  if (!email)    missing.push('ADMIN_EMAIL');
  if (!password) missing.push('ADMIN_PASSWORD');

  if (missing.length) {
    console.error(`❌  Missing required environment variables: ${missing.join(', ')}`);
    console.error('    Add them to your .env file and re-run.\n');
    process.exit(1);
  }

  // ── 2. Connect to MongoDB ──────────────────────────────────────────────────
  try {
    await connectDB();
  } catch (err) {
    console.error('❌  Could not connect to MongoDB:', err.message);
    process.exit(1);
  }

  // ── 3. Guard: abort if an admin with this email already exists ─────────────
  const existing = await User.findOne({ email });

  if (existing) {
    console.log(`ℹ️   An account with email "${email}" already exists.`);
    console.log(`    Role: ${existing.role}  |  Active: ${existing.isActive}`);

    if (existing.role === 'admin') {
      console.log('✅  Admin account is already set up. No changes made.\n');
    } else {
      // Promote the existing account to admin
      existing.role = 'admin';
      await existing.save();
      console.log('🔄  Existing account promoted to admin role.\n');
    }

    await disconnectDB();
    process.exit(0);
  }

  // ── 4. Create the admin user ───────────────────────────────────────────────
  // Password is hashed by the User pre-save hook — do NOT hash it here.
  try {
    const admin = await User.create({ name, email, password, role: 'admin' });

    console.log('✅  Admin account created successfully!');
    console.log(`    Name  : ${admin.name}`);
    console.log(`    Email : ${admin.email}`);
    console.log(`    Role  : ${admin.role}`);
    console.log(`    ID    : ${admin._id}\n`);
    console.log('⚠️   Remove ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD from your');
    console.log('    .env file now that the account has been created.\n');

  } catch (err) {
    console.error('❌  Failed to create admin:', err.message);
    if (err.errors) {
      Object.values(err.errors).forEach((e) => console.error(`    • ${e.message}`));
    }
    await disconnectDB();
    process.exit(1);
  }

  await disconnectDB();
  process.exit(0);
};

run();
