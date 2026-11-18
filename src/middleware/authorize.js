import { AppError } from './errorHandler.js';

/**
 * authorize(...roles)  (middleware factory)
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns a middleware that allows only users whose `role` is in the provided
 * list.  Must be used AFTER the `authenticate` middleware.
 *
 * Usage:
 *   router.delete('/documents/:id', authenticate, authorize('admin'), handler);
 *   router.get('/report',  authenticate, authorize('admin', 'staff'), handler);
 *
 * @param {...string} roles - Allowed role(s)
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    // authenticate() must run first — if it didn't, req.user won't exist
    if (!req.user) {
      return next(new AppError('Authentication required.', 401));
    }

    if (!roles.includes(req.user.role)) {
      return next(
        new AppError(
          `Access denied. This action requires one of the following roles: ${roles.join(', ')}.`,
          403
        )
      );
    }

    next();
  };
};

export default authorize;
