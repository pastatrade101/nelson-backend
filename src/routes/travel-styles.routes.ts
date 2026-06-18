import { Router } from 'express';
import {
  createTravelStyle,
  deleteTravelStyle,
  getTravelStyle,
  listTravelStyles,
  updateTravelStyle
} from '../controllers/travel-styles.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { travelStyleCreateSchema, travelStyleUpdateSchema } from '../schemas/travel-styles.schema';

const router = Router();

router.get('/', listTravelStyles);
router.get('/:slug', getTravelStyle);
router.post('/', authenticate, requirePermission('travel_styles.create'), validate({ body: travelStyleCreateSchema }), createTravelStyle);
router.put('/:id', authenticate, requirePermission('travel_styles.update'), validate({ body: travelStyleUpdateSchema }), updateTravelStyle);
router.delete('/:id', authenticate, requirePermission('travel_styles.delete'), deleteTravelStyle);

export default router;
