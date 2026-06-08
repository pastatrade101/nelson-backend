import { Router } from 'express';
import {
  assignBooking,
  createBooking,
  deleteBooking,
  getBooking,
  getBookingByCode,
  listBookings,
  updateBooking,
  updateBookingNotes,
  updateBookingStatus
} from '../controllers/bookings.controller';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { publicFormLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  bookingAssignSchema,
  bookingCreateSchema,
  bookingNotesSchema,
  bookingStatusSchema,
  bookingUpdateSchema
} from '../schemas/bookings.schema';

const router = Router();

// Public booking submission (website booking form + plan my trip). Rate limited.
// optionalAuthenticate lets admin-created bookings be audited without blocking the public.
router.post('/', optionalAuthenticate, publicFormLimiter, validate({ body: bookingCreateSchema }), createBooking);

router.get('/', authenticate, requirePermission('bookings.view'), listBookings);
router.get('/code/:bookingCode', authenticate, requirePermission('bookings.view'), getBookingByCode);
router.get('/:id', authenticate, requirePermission('bookings.view'), getBooking);
router.put('/:id/status', authenticate, requirePermission('bookings.update'), validate({ body: bookingStatusSchema }), updateBookingStatus);
router.put('/:id/assign', authenticate, requirePermission('bookings.assign'), validate({ body: bookingAssignSchema }), assignBooking);
router.put('/:id/notes', authenticate, requirePermission('bookings.update'), validate({ body: bookingNotesSchema }), updateBookingNotes);
router.put('/:id', authenticate, requirePermission('bookings.update'), validate({ body: bookingUpdateSchema }), updateBooking);
router.delete('/:id', authenticate, requirePermission('bookings.delete'), deleteBooking);

export default router;
