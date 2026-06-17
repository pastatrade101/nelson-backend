import { Router } from 'express';
import {
  createTripPoint,
  deleteTripPoint,
  getTripPoint,
  listTripPoints,
  updateTripPoint
} from '../controllers/trip-points.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { tripPointCreateSchema, tripPointUpdateSchema } from '../schemas/trip-points.schema';

const router = Router();

router.get('/', listTripPoints);
router.get('/:slug', getTripPoint);
router.post('/', authenticate, requirePermission('trip_points.create'), validate({ body: tripPointCreateSchema }), createTripPoint);
router.put('/:id', authenticate, requirePermission('trip_points.update'), validate({ body: tripPointUpdateSchema }), updateTripPoint);
router.delete('/:id', authenticate, requirePermission('trip_points.delete'), deleteTripPoint);

export default router;
