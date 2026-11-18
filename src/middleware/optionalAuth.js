import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { verifyToken } from '../utils/jwt.js';
import { AppError } from './errorHandler.js';

/**
 * optionalAuthenticate  (middleware)
 * ─────────────────────────────────────────────────────────────────────────────
 * Lets a route serve both logged-in students and anonymous visitors.
 *
 *   • No Authorization header      → req.user = null, continue (anonymous)
 *   • Valid Bearer token           → req.user populated, continue
 *   • Present but invalid token    → 401, same messages as authenticate
 *
 * A malformed or expired token is never silently downgraded to an anonymous
 * session: that would scatter a logged-in student's chats into orphan guest
 * conversations.
 */
const optionalAuthenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    // ── Anonymous request ───────────────────────────────────────────────────
    if (!authHeader) {
      req.user = null;
      return next();
    }

    if (!authHeader.startsWith('Bearer ')) {
      return next(new AppError('Authorization header must use the format: Bearer <token>.', 401));
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return next(new AppError('Authentication token is missing.', 401));
    }

    // ── Verify token ────────────────────────────────────────────────────────
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        return next(new AppError('Your session has expired. Please log in again.', 401));
      }
      if (err instanceof jwt.JsonWebTokenError) {
        return next(new AppError('Invalid authentication token.', 401));
      }
      return next(err);
    }

    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return next(new AppError('The account associated with this token no longer exists.', 401));
    }
    if (!user.isActive) {
      return next(new AppError('Your account has been deactivated. Contact an administrator.', 403));
    }

    req.user = user;
    next();

  } catch (err) {
    next(err);
  }
};

export default optionalAuthenticate;
