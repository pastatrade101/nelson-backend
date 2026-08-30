import { Router } from 'express';
import { listLodgeImages, replaceLodgeImages } from '../controllers/lodge-images.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

// Public: the itinerary already embeds the gallery, but a direct read keeps the
// admin and any future property page from needing the tour detail.
router.get('/', listLodgeImages);
router.get('/:lodgeId', listLodgeImages);

// The admin edits a gallery as a whole list, so one atomic replace rather than
// per-image create/update/delete.
router.put('/:lodgeId', authenticate, requirePermission('lodge_images.update'), replaceLodgeImages);

export default router;
