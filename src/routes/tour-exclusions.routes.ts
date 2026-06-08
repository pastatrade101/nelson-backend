import { Router } from 'express';
import {
  createExclusion,
  deleteExclusion,
  getExclusion,
  listExclusions,
  updateExclusion
} from '../controllers/tour-exclusions.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { tourExclusionCreateSchema, tourExclusionUpdateSchema } from '../schemas/tour-exclusions.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('tours.view'), listExclusions);
router.get('/:id', requirePermission('tours.view'), getExclusion);
router.post('/', requirePermission('tours.create'), validate({ body: tourExclusionCreateSchema }), createExclusion);
router.put('/:id', requirePermission('tours.update'), validate({ body: tourExclusionUpdateSchema }), updateExclusion);
router.delete('/:id', requirePermission('tours.delete'), deleteExclusion);

export default router;
