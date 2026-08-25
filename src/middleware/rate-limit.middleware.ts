import rateLimit from 'express-rate-limit';

// Shared by every public lead form (bookings, plan-my-trip, begin-your-journey,
// email-itinerary, contact), so the budget is per IP across ALL of them — not
// per form. 5/hour was low enough to block real enquirers behind one shared IP
// (a family on hotel wifi, an office, or CGNAT mobile), especially since a
// visitor may legitimately send a booking request and then a contact message.
// Turnstile is the primary abuse control; this is a blunt backstop.
export const publicFormLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 15,
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

// Manual exchange-rate refresh (admin) — protect the Open Exchange Rates quota.
export const exchangeRateRefreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 4,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many manual refresh attempts. Please wait and try again.', errors: [] }
});
