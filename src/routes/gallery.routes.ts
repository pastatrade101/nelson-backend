import { Router } from 'express';
import { createGalleryImage, deleteGalleryImage, getGalleryImage, listGalleryImages, updateGalleryImage } from '../controllers/gallery.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { galleryCreateSchema, galleryUpdateSchema } from '../schemas/gallery.schema';

const router = Router();

router.get('/', listGalleryImages);
router.get('/:id', getGalleryImage);
router.post('/', authenticate, requirePermission('gallery.upload'), validate({ body: galleryCreateSchema }), createGalleryImage);
router.put('/:id', authenticate, requirePermission('gallery.upload'), validate({ body: galleryUpdateSchema }), updateGalleryImage);
router.delete('/:id', authenticate, requirePermission('gallery.delete'), deleteGalleryImage);

export default router;
