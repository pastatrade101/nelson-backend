import { Router } from 'express';
import {
  createLodge,
  deleteLodge,
  getLodge,
  listLodges,
  updateLodge
} from '../controllers/lodges.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { lodgeCreateSchema, lodgeUpdateSchema } from '../schemas/lodges.schema';

const router = Router();

router.get('/', listLodges);
router.get('/:slug', getLodge);
router.post('/', authenticate, requirePermission('lodges.create'), validate({ body: lodgeCreateSchema }), createLodge);
router.put('/:id', authenticate, requirePermission('lodges.update'), validate({ body: lodgeUpdateSchema }), updateLodge);
router.delete('/:id', authenticate, requirePermission('lodges.delete'), deleteLodge);

export default router;
