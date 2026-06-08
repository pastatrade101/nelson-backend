import { Router } from 'express';
import { createFaq, deleteFaq, getFaq, listFaqs, updateFaq } from '../controllers/faqs.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { faqCreateSchema, faqUpdateSchema } from '../schemas/faqs.schema';

const router = Router();

router.get('/', listFaqs);
router.get('/:id', getFaq);
router.post('/', authenticate, requirePermission('faqs.create'), validate({ body: faqCreateSchema }), createFaq);
router.put('/:id', authenticate, requirePermission('faqs.update'), validate({ body: faqUpdateSchema }), updateFaq);
router.delete('/:id', authenticate, requirePermission('faqs.delete'), deleteFaq);

export default router;
