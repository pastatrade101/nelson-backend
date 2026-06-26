import { Router } from 'express';
import {
  adminCreateTripLink,
  exchangeTripToken,
  getTrip,
  logoutTrip,
  postTripMessage,
  requestTripAccess
} from '../controllers/trip-portal.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { authenticateTrip } from '../middleware/trip-auth.middleware';
import { tripAccessLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

// Public (magic link) — exchange a token for a session, then read/act on the trip.
router.post('/request-access', tripAccessLimiter, requestTripAccess);
router.post('/session', tripAccessLimiter, exchangeTripToken);
router.get('/me', authenticateTrip, getTrip);
router.post('/message', tripAccessLimiter, authenticateTrip, postTripMessage);
router.post('/logout', logoutTrip);

// Admin — generate a secure link to send to the customer.
router.post('/admin/links', authenticate, requirePermission('bookings.update'), adminCreateTripLink);

export default router;
