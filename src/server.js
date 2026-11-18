import { pathToFileURL } from 'node:url';
import app from './app.js';
import config from './config/env.js';
import connectDB, { disconnectDB } from './config/db.js';
import handler from './serverless.js';

const PORT = config.PORT;

// ── Bootstrap: connect to DB first, then start HTTP server ───────────────────
const bootstrap = async () => {
  try {
    await connectDB();

    const server = app.listen(PORT, () => {
      console.log('─────────────────────────────────────────────');
      console.log(`🚀  Server running in ${config.NODE_ENV} mode`);
      console.log(`🌐  Listening on http://localhost:${PORT}`);
      console.log(`💚  Health   → http://localhost:${PORT}/api/health`);
      console.log(`🔍  Status   → http://localhost:${PORT}/api/system/status`);
      console.log('─────────────────────────────────────────────');
    });

    // ── Graceful shutdown ───────────────────────────────────────────────────
    const shutdown = async (signal) => {
      console.log(`\n⚠️  ${signal} received. Shutting down gracefully...`);

      // 1. Stop accepting new connections
      server.close(async () => {
        console.log('✅  HTTP server closed.');

        // 2. Close the database connection
        await disconnectDB();

        process.exit(0);
      });

      // Force exit if graceful shutdown stalls
      setTimeout(() => {
        console.error('❌  Forced shutdown after timeout.');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    // ── Unhandled promise rejections ────────────────────────────────────────
    process.on('unhandledRejection', async (reason) => {
      console.error('💥 Unhandled Rejection:', reason);
      await disconnectDB();
      server.close(() => process.exit(1));
    });

  } catch (err) {
    // Fatal: could not connect to DB — do not start the server
    console.error('💥  Failed to start server:', err.message);
    process.exit(1);
  }
};

// Only start a listener when executed directly (`node src/server.js`).
// Serverless platforms import this file and use the handler export instead.
const isDirectRun =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) bootstrap();

export default handler;
