import { Router } from 'express';
import { getBranding, updateBranding } from '../controllers/branding.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { brandingSchema } from '../schemas/branding.schema';

const router = Router();

router.get('/', getBranding);
router.put('/', authenticate, requirePermission('settings.update'), validate({ body: brandingSchema }), updateBranding);

export default router;
