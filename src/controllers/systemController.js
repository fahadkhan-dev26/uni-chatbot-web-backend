import mongoose from 'mongoose';
import config from '../config/env.js';
import { getDbStatus } from '../config/db.js';

/**
 * GET /api/system/status
 * Returns the current status of the API and its dependencies.
 * Safe to expose — no secrets are leaked.
 */
export const systemStatus = (req, res) => {
  const dbState = mongoose.connection.readyState; // 0=disconnected, 1=connected
  const isDbConnected = dbState === 1;

  const status = {
    success: true,
    api: {
      status:      'online',
      environment: config.NODE_ENV,
      uptime:      `${Math.floor(process.uptime())}s`,
      timestamp:   new Date().toISOString(),
    },
    database: {
      status:   getDbStatus(),
      name:     isDbConnected ? mongoose.connection.name : null,
      host:     isDbConnected ? mongoose.connection.host : null,
    },
  };

  // Return 503 if the database is not connected so load balancers can detect it
  const httpStatus = isDbConnected ? 200 : 503;
  res.status(httpStatus).json(status);
};
