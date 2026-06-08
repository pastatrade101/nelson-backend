import { Router } from 'express';
import {
  createTestimonial,
  deleteTestimonial,
  getTestimonial,
  listTestimonials,
  updateTestimonial
} from '../controllers/testimonials.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { testimonialCreateSchema, testimonialUpdateSchema } from '../schemas/testimonials.schema';

const router = Router();

router.get('/', listTestimonials);
router.get('/:id', getTestimonial);
router.post('/', authenticate, requirePermission('testimonials.create'), validate({ body: testimonialCreateSchema }), createTestimonial);
router.put('/:id', authenticate, requirePermission('testimonials.update'), validate({ body: testimonialUpdateSchema }), updateTestimonial);
router.delete('/:id', authenticate, requirePermission('testimonials.delete'), deleteTestimonial);

export default router;
