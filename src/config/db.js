import mongoose from 'mongoose';
import config from './env.js';

// ── Connection state labels (mongoose readyState integers) ────────────────────
const DB_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

/**
 * Returns a human-readable label for the current Mongoose connection state.
 * @returns {string}
 */
export const getDbStatus = () => DB_STATES[mongoose.connection.readyState] ?? 'unknown';

/**
 * Connects to MongoDB Atlas using the URI in config.MONGODB_URI.
 * - Sets the database name to "UniversityAIChatbot".
 * - Registers connection event listeners for logging & graceful recovery.
 * - Should be called once before starting the HTTP server.
 *
 * @throws {Error} if MONGODB_URI is not set or the initial connection fails.
 */
const connectDB = async () => {
  if (!config.MONGODB_URI) {
    throw new Error(
      'MONGODB_URI is not set. Add it to your .env file.\n' +
      'Example: mongodb+srv://<user>:<password>@cluster.mongodb.net/UniversityAIChatbot'
    );
  }

  // ── Mongoose connection options ─────────────────────────────────────────────
  const options = {
    dbName: 'UniversityAIChatbot', // Always use this database regardless of URI path
  };

  // ── Event listeners (registered once before connect) ───────────────────────
  mongoose.connection.on('connected', () => {
    console.log(`✅  MongoDB connected → ${maskUri(config.MONGODB_URI)}`);
    console.log(`📦  Database: ${mongoose.connection.name}`);
  });

  mongoose.connection.on('error', (err) => {
    console.error('❌  MongoDB connection error:', err.message);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('⚠️  MongoDB disconnected. Attempting to reconnect...');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('🔄  MongoDB reconnected.');
  });

  // ── Initial connection ──────────────────────────────────────────────────────
  await mongoose.connect(config.MONGODB_URI, options);
};

/**
 * Closes the Mongoose connection cleanly.
 * Call this during graceful server shutdown.
 */
export const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    console.log('🔌  MongoDB connection closed.');
  }
};

/**
 * Masks the password in a MongoDB URI for safe console logging.
 * mongodb+srv://user:SECRET@cluster → mongodb+srv://user:****@cluster
 *
 * @param {string} uri
 * @returns {string}
 */
const maskUri = (uri) => uri.replace(/:([^@]+)@/, ':****@');

export default connectDB;
