import config from '../config/env.js';

/**
 * Custom application error class.
 * Use this to throw operational errors with a specific HTTP status code.
 *
 * @example
 *   throw new AppError('User not found', 404);
 */
export class AppError extends Error {
  /**
   * @param {string} message  - Human-readable error message
   * @param {number} statusCode - HTTP status code (default 500)
   */
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // distinguishes known errors from unexpected ones
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * 404 handler — place AFTER all routes.
 */
export const notFoundHandler = (req, res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
};

/**
 * Global error handler — place LAST in the middleware chain.
 * Express identifies it as an error handler because it has 4 parameters.
 */
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  const isProduction = config.NODE_ENV === 'production';

  // Log unexpected errors server-side
  if (!err.isOperational) {
    console.error('💥 Unexpected error:', err);
  }

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal Server Error',
    // Include stack trace in development only
    ...(isProduction ? {} : { stack: err.stack }),
  });
};
