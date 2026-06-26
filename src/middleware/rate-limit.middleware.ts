import rateLimit from 'express-rate-limit';

export const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many submissions. Please try again later.',
    errors: []
  }
});

// Trip portal: throttle token exchange (slows brute force, though 256-bit
// tokens are unguessable) and traveller messages (anti-spam) per IP.
export const tripAccessLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Please wait a few minutes and try again.', errors: [] }
});

// Analytics events fire far more often than form posts (clicks, opens), so this
// limiter is generous per-IP but still caps abusive flooding.
export const analyticsEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many events.', errors: [] }
});
