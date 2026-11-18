import jwt from 'jsonwebtoken';
import config from '../config/env.js';

/**
 * Signs a JWT containing the given payload.
 *
 * @param {object} payload   - Data to embed (e.g. { id, role })
 * @param {string} [expiresIn] - Override the default expiry from config
 * @returns {string} Signed JWT string
 */
export const signToken = (payload, expiresIn = config.JWT_EXPIRES_IN) => {
  if (!config.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured. Set it in your .env file.');
  }
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn });
};

/**
 * Verifies a JWT and returns its decoded payload.
 * Throws a JsonWebTokenError / TokenExpiredError on failure — the caller
 * is responsible for catching those and converting them to HTTP responses.
 *
 * @param {string} token
 * @returns {object} Decoded payload
 */
export const verifyToken = (token) => {
  if (!config.JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured. Set it in your .env file.');
  }
  return jwt.verify(token, config.JWT_SECRET);
};
