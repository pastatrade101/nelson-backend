import { Router } from 'express';
import {
  createActivity,
  deleteActivity,
  getActivity,
  listActivities,
  updateActivity
} from '../controllers/activities.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { activityCreateSchema, activityUpdateSchema } from '../schemas/activities.schema';

const router = Router();

router.get('/', listActivities);
router.get('/:slug', getActivity);
router.post('/', authenticate, requirePermission('activities.create'), validate({ body: activityCreateSchema }), createActivity);
router.put('/:id', authenticate, requirePermission('activities.update'), validate({ body: activityUpdateSchema }), updateActivity);
router.delete('/:id', authenticate, requirePermission('activities.delete'), deleteActivity);

export default router;
