import { Router } from 'express';
import {
  createSpecialist,
  deleteSpecialist,
  getSpecialist,
  listSpecialists,
  updateSpecialist
} from '../controllers/specialists.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { specialistCreateSchema, specialistUpdateSchema } from '../schemas/specialists.schema';

const router = Router();

router.get('/', listSpecialists);
router.get('/:id', getSpecialist);
router.post('/', authenticate, requirePermission('specialists.create'), validate({ body: specialistCreateSchema }), createSpecialist);
router.put('/:id', authenticate, requirePermission('specialists.update'), validate({ body: specialistUpdateSchema }), updateSpecialist);
router.delete('/:id', authenticate, requirePermission('specialists.delete'), deleteSpecialist);

export default router;
