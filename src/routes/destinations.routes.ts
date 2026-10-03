import { Router } from 'express';
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinationCountries,
  listDestinationTours,
  listDestinations,
  updateDestination
} from '../controllers/destinations.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { destinationCreateSchema, destinationUpdateSchema } from '../schemas/destinations.schema';

const router = Router();

router.get('/', listDestinations);
// Must precede '/:slug', or 'countries' is read as a destination slug.
router.get('/countries', listDestinationCountries);
// Tours connected through the data model (own destination, or a night at one of its lodges).
router.get('/:id/tours', listDestinationTours);
router.get('/:slug', getDestination);
router.post('/', authenticate, requirePermission('destinations.create'), validate({ body: destinationCreateSchema }), createDestination);
router.put('/:id', authenticate, requirePermission('destinations.update'), validate({ body: destinationUpdateSchema }), updateDestination);
router.delete('/:id', authenticate, requirePermission('destinations.delete'), deleteDestination);

export default router;
