import { Router } from 'express';
import {
  createComparison,
  deleteComparison,
  getComparison,
  listComparisons,
  updateComparison
} from '../controllers/comparisons.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { comparisonCreateSchema, comparisonUpdateSchema } from '../schemas/comparisons.schema';

const router = Router();

router.get('/', listComparisons);
router.get('/:slug', getComparison);
router.post('/', authenticate, requirePermission('comparisons.create'), validate({ body: comparisonCreateSchema }), createComparison);
router.put('/:id', authenticate, requirePermission('comparisons.update'), validate({ body: comparisonUpdateSchema }), updateComparison);
router.delete('/:id', authenticate, requirePermission('comparisons.delete'), deleteComparison);

export default router;
