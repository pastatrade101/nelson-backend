import { Router } from 'express';
import {
  createCountry,
  deleteCountry,
  getCountry,
  listCountries,
  updateCountry
} from '../controllers/countries.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { countryCreateSchema, countryUpdateSchema } from '../schemas/countries.schema';

const router = Router();

router.get('/', listCountries);
router.get('/:slug', getCountry);
router.post('/', authenticate, requirePermission('countries.create'), validate({ body: countryCreateSchema }), createCountry);
router.put('/:id', authenticate, requirePermission('countries.update'), validate({ body: countryUpdateSchema }), updateCountry);
router.delete('/:id', authenticate, requirePermission('countries.delete'), deleteCountry);

export default router;
