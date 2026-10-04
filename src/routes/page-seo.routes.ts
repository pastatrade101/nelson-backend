import { Router } from 'express';
import {
  createPageSeo,
  deletePageSeo,
  getPageSeo,
  listPageSeo,
  listPageSeoIndexingRules,
  resolvePageSeo,
  updatePageSeo
} from '../controllers/page-seo.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { pageSeoCreateSchema, pageSeoUpdateSchema } from '../schemas/page-seo.schema';

const router = Router();

router.get('/resolve', resolvePageSeo);
router.get('/indexing-rules', listPageSeoIndexingRules);

router.get('/', authenticate, requirePermission('page_seo.view'), listPageSeo);
router.get('/:id', authenticate, requirePermission('page_seo.view'), getPageSeo);
router.post('/', authenticate, requirePermission('page_seo.create'), validate({ body: pageSeoCreateSchema }), createPageSeo);
router.put('/:id', authenticate, requirePermission('page_seo.update'), validate({ body: pageSeoUpdateSchema }), updatePageSeo);
router.delete('/:id', authenticate, requirePermission('page_seo.delete'), deletePageSeo);

export default router;
