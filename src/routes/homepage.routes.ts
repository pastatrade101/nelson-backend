import { Router } from 'express';
import {
  createHomepageSection,
  deleteHomepageSection,
  getHomepage,
  updateHomepage,
  updateHomepageSection
} from '../controllers/homepage.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { homepageSectionCreateSchema, homepageSectionUpdateSchema } from '../schemas/homepage.schema';

const router = Router();

router.get('/', getHomepage);
router.put('/', authenticate, requirePermission('homepage.update'), updateHomepage);
router.post('/sections', authenticate, requirePermission('homepage.update'), validate({ body: homepageSectionCreateSchema }), createHomepageSection);
router.put('/sections/:id', authenticate, requirePermission('homepage.update'), validate({ body: homepageSectionUpdateSchema }), updateHomepageSection);
router.delete('/sections/:id', authenticate, requirePermission('homepage.update'), deleteHomepageSection);

export default router;
