import { Router } from 'express';
import {
  internalLinkHealth,
  repairInternalLinks,
  resolveInternalLinks,
  searchInternalLinks
} from '../controllers/internal-links.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requireAnyPermission, requirePermission } from '../middleware/permission.middleware';

const router = Router();

// Admin-only: the picker and checks serve editors writing copy. Search returns
// published pages only, so nothing here exposes drafts to anyone.
router.use(authenticate);

const editors = requireAnyPermission('tours.create', 'tours.update', 'blog.create', 'blog.update', 'destinations.update');

router.get('/search', editors, searchInternalLinks);
router.get('/resolve', editors, resolveInternalLinks);
router.get('/health', requirePermission('tours.view'), internalLinkHealth);
router.post('/repair', requirePermission('tours.update'), repairInternalLinks);

export default router;
