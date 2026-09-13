import { Router } from 'express';
import multer from 'multer';
import {
  createGuestLink,
  createStandaloneForm,
  createStandaloneLink,
  getGuestForm_admin,
  listGuestForms,
  setStandaloneLock,
  getBookingGuestDetails,
  getGuestDocumentUrl,
  getGuestForm,
  revokeGuestLink,
  saveGuestForm,
  setGuestDetailsLock,
  uploadGuestDocument
} from '../controllers/guest-details.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { tripAccessLimiter } from '../middleware/rate-limit.middleware';

/**
 * Two surfaces, deliberately separated.
 *
 * `/token/:token` is reachable without a login, so every route under it is rate
 * limited and proves possession of a valid guest_details token on each call.
 * There is no session cookie: the token is the credential, checked every time,
 * which keeps a shared browser from leaving the form open to the next person.
 *
 * Everything else requires an admin login and an explicit permission.
 */
const router = Router();

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
});

// ── Guest, by token ───────────────────────────────────────────────────────
router.get('/token/:token', tripAccessLimiter, getGuestForm);
router.put('/token/:token', tripAccessLimiter, saveGuestForm);
router.post('/token/:token/document', tripAccessLimiter, documentUpload.single('file'), uploadGuestDocument);

// ── Office ────────────────────────────────────────────────────────────────
// Forms that stand alone, with no booking behind them — the common case when
// passport details are needed before a booking row exists.
router.get('/forms', authenticate, requirePermission('guest_details.view'), listGuestForms);
router.post('/forms', authenticate, requirePermission('guest_details.manage'), createStandaloneForm);
router.get('/forms/:submissionId', authenticate, requirePermission('guest_details.view'), getGuestForm_admin);
router.post('/forms/:submissionId/link', authenticate, requirePermission('guest_details.manage'), createStandaloneLink);
router.put('/forms/:submissionId/lock', authenticate, requirePermission('guest_details.manage'), setStandaloneLock);

router.post('/bookings/:id/link', authenticate, requirePermission('guest_details.manage'), createGuestLink);
router.delete('/bookings/:id/link', authenticate, requirePermission('guest_details.manage'), revokeGuestLink);
router.get('/bookings/:id', authenticate, requirePermission('guest_details.view'), getBookingGuestDetails);
router.put('/bookings/:id/lock', authenticate, requirePermission('guest_details.manage'), setGuestDetailsLock);
router.get('/travellers/:travellerId/document', authenticate, requirePermission('guest_details.view'), getGuestDocumentUrl);

export default router;
