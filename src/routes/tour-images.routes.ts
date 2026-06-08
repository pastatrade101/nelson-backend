import { Router } from 'express';
import {
  createTourImage,
  deleteTourImage,
  getTourImage,
  listTourImages,
  updateTourImage
} from '../controllers/tour-images.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { tourImageCreateSchema, tourImageUpdateSchema } from '../schemas/tour-images.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('tours.view'), listTourImages);
router.get('/:id', requirePermission('tours.view'), getTourImage);
router.post('/', requirePermission('tours.create'), validate({ body: tourImageCreateSchema }), createTourImage);
router.put('/:id', requirePermission('tours.update'), validate({ body: tourImageUpdateSchema }), updateTourImage);
router.delete('/:id', requirePermission('tours.delete'), deleteTourImage);

export default router;
