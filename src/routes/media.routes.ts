import { Router } from 'express';
import { createMedia, deleteMedia, listMedia, updateMedia } from '../controllers/media.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { mediaCreateSchema, mediaUpdateSchema } from '../schemas/media.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('media.view'), listMedia);
router.post('/', requirePermission('media.upload'), validate({ body: mediaCreateSchema }), createMedia);
router.put('/:id', requirePermission('media.upload'), validate({ body: mediaUpdateSchema }), updateMedia);
router.delete('/:id', requirePermission('media.delete'), deleteMedia);

export default router;
