import { Router } from 'express';
import { createCategory, deleteCategory, getCategory, listCategories, updateCategory } from '../controllers/categories.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { categoryCreateSchema, categoryUpdateSchema } from '../schemas/categories.schema';

const router = Router();

router.get('/', listCategories);
router.get('/:slug', getCategory);
router.post('/', authenticate, requirePermission('categories.create'), validate({ body: categoryCreateSchema }), createCategory);
router.put('/:id', authenticate, requirePermission('categories.update'), validate({ body: categoryUpdateSchema }), updateCategory);
router.delete('/:id', authenticate, requirePermission('categories.delete'), deleteCategory);

export default router;
