import { Router } from 'express';
import {
  createSafariEssential,
  deleteSafariEssential,
  getSafariEssential,
  listSafariEssentials,
  updateSafariEssential
} from '../controllers/safari-essentials.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { safariEssentialCreateSchema, safariEssentialUpdateSchema } from '../schemas/safari-essentials.schema';

const router = Router();

router.get('/', listSafariEssentials);
router.get('/:slug', getSafariEssential);
router.post(
  '/',
  authenticate,
  requirePermission('safari_essentials.create'),
  validate({ body: safariEssentialCreateSchema }),
  createSafariEssential
);
router.put(
  '/:id',
  authenticate,
  requirePermission('safari_essentials.update'),
  validate({ body: safariEssentialUpdateSchema }),
  updateSafariEssential
);
router.delete('/:id', authenticate, requirePermission('safari_essentials.delete'), deleteSafariEssential);

export default router;
