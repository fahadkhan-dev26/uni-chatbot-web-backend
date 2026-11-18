import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { verifyToken } from '../utils/jwt.js';
import { AppError } from './errorHandler.js';

/**
 * authenticate  (middleware)
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts the JWT from the Authorization header, verifies it, loads the user
 * from the database, and attaches them to req.user.
 *
 * Expected header format:
 *   Authorization: Bearer <token>
 *
 * On success  → calls next()  with req.user populated
 * On failure  → passes an AppError to the global error handler
 */
const authenticate = async (req, res, next) => {
  try {
    // ── 1. Extract token ────────────────────────────────────────────────────
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return next(new AppError('Authentication required. Please log in.', 401));
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      return next(new AppError('Authentication token is missing.', 401));
    }

    // ── 2. Verify token ─────────────────────────────────────────────────────
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

    // ── 3. Load user from DB (confirms they still exist and are active) ─────
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      return next(new AppError('The account associated with this token no longer exists.', 401));
    }

    if (!user.isActive) {
      return next(new AppError('Your account has been deactivated. Contact an administrator.', 403));
    }

    // ── 4. Attach user to request ───────────────────────────────────────────
    req.user = user;
    next();

  } catch (err) {
    next(err);
  }
};

export default authenticate;
