import { Router } from 'express';
import {
  createInclusion,
  deleteInclusion,
  getInclusion,
  listInclusions,
  updateInclusion
} from '../controllers/tour-inclusions.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { tourInclusionCreateSchema, tourInclusionUpdateSchema } from '../schemas/tour-inclusions.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('tours.view'), listInclusions);
router.get('/:id', requirePermission('tours.view'), getInclusion);
router.post('/', requirePermission('tours.create'), validate({ body: tourInclusionCreateSchema }), createInclusion);
router.put('/:id', requirePermission('tours.update'), validate({ body: tourInclusionUpdateSchema }), updateInclusion);
router.delete('/:id', requirePermission('tours.delete'), deleteInclusion);

export default router;
