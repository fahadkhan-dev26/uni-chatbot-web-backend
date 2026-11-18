import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import config from '../config/env.js';

/**
 * General API rate limiter.
 * Limits each IP to `RATE_LIMIT_MAX` requests per `RATE_LIMIT_WINDOW_MS`.
 */
export const apiLimiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max:      config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
  },
});

/**
 * Strict auth rate limiter — applied only to login / register endpoints.
 * 10 attempts per 15 minutes per IP to slow brute-force attacks.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  skipSuccessfulRequests: true, // only counts failed attempts toward the limit
  message: {
    success: false,
    message: 'Too many login attempts from this IP. Please try again in 15 minutes.',
  },
});

/**
 * Chat rate limiter — applied to POST /api/chat/message.
 * Each AI answer costs a retrieval query plus a local model run, so the budget
 * is much tighter than the general API limit. Logged-in students are limited
 * per account; guests are limited per IP.
 *
 * Mount it AFTER optionalAuth so req.user is known.
 */
export const chatLimiter = rateLimit({
  windowMs: config.CHAT_RATE_LIMIT_WINDOW_MS,
  limit:    config.CHAT_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator: (req) =>
    req.user ? `user:${req.user._id}` : `ip:${ipKeyGenerator(req.ip)}`,
  message: {
    success: false,
    code:    'RATE_LIMITED',
    message: 'You are sending questions too quickly. Please wait a minute and try again.',
  },
});

// Keep the default export so existing imports in app.js still work
export default apiLimiter;
