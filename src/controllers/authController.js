import User from '../models/User.js';
import { signToken } from '../utils/jwt.js';
import { AppError } from '../middleware/errorHandler.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Builds the JWT payload, signs it, and returns a sanitised user object.
 * Keeps the token-creation logic in one place.
 *
 * @param {import('../models/User.js').default} user
 * @returns {{ token: string, user: object }}
 */
const createTokenResponse = (user) => {
  const payload = { id: user._id, role: user.role };
  const token   = signToken(payload);

  // Strip sensitive fields before sending to the client
  const safeUser = {
    _id:       user._id,
    name:      user.name,
    email:     user.email,
    role:      user.role,
    isActive:  user.isActive,
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
  };

  return { token, user: safeUser };
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * POST /api/auth/login
 * Body: { email, password }
 *
 * Intentionally uses the same generic error message for wrong email OR wrong
 * password to avoid user-enumeration attacks.
 */
export const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // ── Input validation ──────────────────────────────────────────────────
    if (!email || !password) {
      return next(new AppError('Email and password are required.', 400));
    }

    if (typeof email !== 'string' || typeof password !== 'string') {
      return next(new AppError('Invalid input format.', 400));
    }

    // ── Look up user — explicitly select password (select:false in schema) ─
    const user = await User.findOne({ email: email.toLowerCase().trim() })
                           .select('+password');

    // ── Timing-safe check: always call comparePassword even on a null user
    //    so response time doesn't reveal whether the email exists. ──────────
    const dummyHash = '$2a$12$invalidhashfortimingnormalization00000000000000000000';
    const passwordMatch = user
      ? await user.comparePassword(password)
      : await import('bcryptjs').then(({ default: bcrypt }) =>
          bcrypt.compare(password, dummyHash)
        );

    if (!user || !passwordMatch) {
      return next(new AppError('Invalid email or password.', 401));
    }

    // ── Account checks ────────────────────────────────────────────────────
    if (!user.isActive) {
      return next(new AppError('Your account has been deactivated. Contact an administrator.', 403));
    }

    // ── Update lastLogin (fire-and-forget — don't await, don't block) ─────
    User.findByIdAndUpdate(user._id, { lastLogin: new Date() }).catch(() => {});

    // ── Issue token ───────────────────────────────────────────────────────
    const { token, user: safeUser } = createTokenResponse(user);

    res.status(200).json({
      success: true,
      message: 'Login successful.',
      token,
      user: safeUser,
    });

  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/auth/logout
 * JWT is stateless, so logout is handled client-side by discarding the token.
 * This endpoint gives the frontend a consistent API surface and can be
 * extended later to maintain a server-side token denylist if needed.
 */
export const logout = (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully. Please discard your token on the client.',
  });
};

/**
 * GET /api/auth/me
 * Protected — requires authenticate middleware.
 * Returns the authenticated user's profile without sensitive fields.
 */
export const getMe = async (req, res, next) => {
  try {
    // req.user is set by the authenticate middleware (password already excluded)
    const user = await User.findById(req.user._id);

    if (!user) {
      return next(new AppError('User not found.', 404));
    }

    res.status(200).json({
      success: true,
      user: {
        _id:       user._id,
        name:      user.name,
        email:     user.email,
        role:      user.role,
        isActive:  user.isActive,
        lastLogin: user.lastLogin,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    });

  } catch (err) {
    next(err);
  }
};
