import { Router } from 'express';
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  updateDestination
} from '../controllers/destinations.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { destinationCreateSchema, destinationUpdateSchema } from '../schemas/destinations.schema';

const router = Router();

router.get('/', listDestinations);
router.get('/:slug', getDestination);
router.post('/', authenticate, requirePermission('destinations.create'), validate({ body: destinationCreateSchema }), createDestination);
router.put('/:id', authenticate, requirePermission('destinations.update'), validate({ body: destinationUpdateSchema }), updateDestination);
router.delete('/:id', authenticate, requirePermission('destinations.delete'), deleteDestination);

export default router;
