import { Router } from 'express';
import {
  createLodge,
  deleteLodge,
  getLodge,
  listLodgeItineraries,
  listLodges,
  updateLodge
} from '../controllers/lodges.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { getLodgeDetails, replaceLodgeDetails } from '../controllers/lodge-details.controller';
import { lodgeCreateSchema, lodgeDetailsReplaceSchema, lodgeUpdateSchema } from '../schemas/lodges.schema';

const router = Router();

router.get('/', listLodges);
// Two segments, so it cannot be mistaken for a slug.
router.get('/:id/itineraries', listLodgeItineraries);
// Authenticated on purpose. This is the admin editor's read, and it selects the
// rate rows in full — net_rate and notes included, which the public detail
// endpoint deliberately withholds. The permission already exists alongside the
// update grant. Public pages get their rates from `GET /:slug`, gated on the
// property's own show_rates_publicly.
router.get('/:id/details', authenticate, requirePermission('lodge_details.view'), getLodgeDetails);
router.put(
  '/:id/details',
  authenticate,
  requirePermission('lodge_details.update'),
  validate({ body: lodgeDetailsReplaceSchema }),
  replaceLodgeDetails
);
router.get('/:slug', getLodge);
router.post('/', authenticate, requirePermission('lodges.create'), validate({ body: lodgeCreateSchema }), createLodge);
router.put('/:id', authenticate, requirePermission('lodges.update'), validate({ body: lodgeUpdateSchema }), updateLodge);
router.delete('/:id', authenticate, requirePermission('lodges.delete'), deleteLodge);

export default router;
