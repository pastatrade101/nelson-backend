import { Router } from 'express';
import { listTourAvailableDates } from '../controllers/available-dates.controller';
import { listTourItineraries } from '../controllers/itineraries.controller';
import { listTourPricingOptions } from '../controllers/pricing-options.controller';
import { listTourInclusions } from '../controllers/tour-inclusions.controller';
import { listTourExclusions } from '../controllers/tour-exclusions.controller';
import { listTourImagesForTour } from '../controllers/tour-images.controller';
import { createTour, deleteTour, getTour, listTours, updateTour } from '../controllers/tours.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { tourCreateSchema, tourUpdateSchema } from '../schemas/tours.schema';

const router = Router();

router.get('/', listTours);
router.get('/:tourId/itineraries', authenticate, requirePermission('tours.view'), listTourItineraries);
router.get('/:tourId/available-dates', authenticate, requirePermission('tours.view'), listTourAvailableDates);
router.get('/:tourId/pricing-options', authenticate, requirePermission('tours.view'), listTourPricingOptions);
router.get('/:tourId/inclusions', authenticate, requirePermission('tours.view'), listTourInclusions);
router.get('/:tourId/exclusions', authenticate, requirePermission('tours.view'), listTourExclusions);
router.get('/:tourId/images', authenticate, requirePermission('tours.view'), listTourImagesForTour);
router.get('/:slug', getTour);
router.post('/', authenticate, requirePermission('tours.create'), validate({ body: tourCreateSchema }), createTour);
router.put('/:id', authenticate, requirePermission('tours.update'), validate({ body: tourUpdateSchema }), updateTour);
router.delete('/:id', authenticate, requirePermission('tours.delete'), deleteTour);

export default router;
