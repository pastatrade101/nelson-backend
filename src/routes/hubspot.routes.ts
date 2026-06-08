import { Router } from 'express';
import { syncBooking, syncLead } from '../controllers/hubspot.controller';
import { publicFormLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { hubspotBookingSchema, hubspotLeadSchema } from '../schemas/hubspot.schema';

const router = Router();

router.post('/sync-lead', publicFormLimiter, validate({ body: hubspotLeadSchema }), syncLead);
router.post('/sync-booking', publicFormLimiter, validate({ body: hubspotBookingSchema }), syncBooking);

export default router;
