import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { quotationActionLimiter } from '../middleware/rate-limit.middleware';
import {
  acceptPublicQuotation,
  createQuotation,
  declinePublicQuotation,
  deleteQuotation,
  getPublicQuotation,
  getQuotation,
  listQuotations,
  sendQuotation,
  setQuotationStatus,
  updateQuotation
} from '../controllers/quotations.controller';

const router = Router();

// The traveller's view. Token-only by design — they have a link, not an
// account — so this route is deliberately public and returns just the offer.
router.get('/public/:token', getPublicQuotation);

// Their answer to it. Rate limited: the token is the credential, so these are
// the only two routes where holding a link changes anything.
router.post('/public/:token/accept', quotationActionLimiter, acceptPublicQuotation);
router.post('/public/:token/decline', quotationActionLimiter, declinePublicQuotation);

// Admin. Quotations are commercial documents about a booking, so they follow
// the existing bookings permissions rather than inventing a parallel scheme.
router.get('/', authenticate, requirePermission('bookings.view'), listQuotations);
router.get('/:id', authenticate, requirePermission('bookings.view'), getQuotation);
router.post('/', authenticate, requirePermission('bookings.update'), createQuotation);
router.put('/:id', authenticate, requirePermission('bookings.update'), updateQuotation);
router.post('/:id/send', authenticate, requirePermission('bookings.update'), sendQuotation);
router.patch('/:id/status', authenticate, requirePermission('bookings.update'), setQuotationStatus);
router.delete('/:id', authenticate, requirePermission('bookings.delete'), deleteQuotation);

export default router;
