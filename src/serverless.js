import app from './app.js';
import connectDB from './config/db.js';

// Serverless instances are reused, so the connection is cached per process.
// A failed attempt is cleared to allow the next request to retry.
let connectionPromise = null;

const ensureConnection = () => {
  if (!connectionPromise) {
    connectionPromise = connectDB().catch((err) => {
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
};

export default async function handler(req, res) {
  // The liveness probe must answer even when the database is unreachable.
  const isLivenessProbe = (req.url ?? '').startsWith('/api/health');

  if (!isLivenessProbe) {
    try {
      await ensureConnection();
    } catch (err) {
      console.error('❌  Database connection failed:', err.message);
      return res.status(503).json({
        success: false,
        message: 'The API cannot reach its database. Check MONGODB_URI.',
      });
    }
  }

  return app(req, res);
}
