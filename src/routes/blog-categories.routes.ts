import { Router } from 'express';
import { createBlogCategory, deleteBlogCategory, getBlogCategory, listBlogCategories, updateBlogCategory } from '../controllers/blog-categories.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { blogCategoryCreateSchema, blogCategoryUpdateSchema } from '../schemas/blog-categories.schema';

const router = Router();

router.get('/', listBlogCategories);
router.get('/:slug', getBlogCategory);
router.post('/', authenticate, requirePermission('blog.create'), validate({ body: blogCategoryCreateSchema }), createBlogCategory);
router.put('/:id', authenticate, requirePermission('blog.update'), validate({ body: blogCategoryUpdateSchema }), updateBlogCategory);
router.delete('/:id', authenticate, requirePermission('blog.delete'), deleteBlogCategory);

export default router;
