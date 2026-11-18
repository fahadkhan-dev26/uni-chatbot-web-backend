import config from '../config/env.js';

/**
 * GET /api/health
 * Returns a simple status payload so load balancers and devs can verify
 * the server is running.
 */
export const healthCheck = (req, res) => {
  res.status(200).json({
    success: true,
    message: 'University AI Chatbot API is running',
    environment: config.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptime: `${Math.floor(process.uptime())}s`,
  });
};
