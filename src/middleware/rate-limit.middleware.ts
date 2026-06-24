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

// Analytics events fire far more often than form posts (clicks, opens), so this
// limiter is generous per-IP but still caps abusive flooding.
export const analyticsEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many events.', errors: [] }
});
