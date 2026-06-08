import { Router } from 'express';
import {
  createItinerary,
  deleteItinerary,
  getItinerary,
  listItineraries,
  updateItinerary
} from '../controllers/itineraries.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { itineraryCreateSchema, itineraryUpdateSchema } from '../schemas/itineraries.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('tours.view'), listItineraries);
router.get('/:id', requirePermission('tours.view'), getItinerary);
router.post('/', requirePermission('tours.create'), validate({ body: itineraryCreateSchema }), createItinerary);
router.put('/:id', requirePermission('tours.update'), validate({ body: itineraryUpdateSchema }), updateItinerary);
router.delete('/:id', requirePermission('tours.delete'), deleteItinerary);

export default router;
