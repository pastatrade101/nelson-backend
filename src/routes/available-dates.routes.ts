import { Router } from 'express';
import {
  createAvailableDate,
  deleteAvailableDate,
  getAvailableDate,
  listAvailableDates,
  updateAvailableDate
} from '../controllers/available-dates.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { availableDateCreateSchema, availableDateUpdateSchema } from '../schemas/available-dates.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('tours.view'), listAvailableDates);
router.get('/:id', requirePermission('tours.view'), getAvailableDate);
router.post('/', requirePermission('tours.create'), validate({ body: availableDateCreateSchema }), createAvailableDate);
router.put('/:id', requirePermission('tours.update'), validate({ body: availableDateUpdateSchema }), updateAvailableDate);
router.delete('/:id', requirePermission('tours.delete'), deleteAvailableDate);

export default router;
