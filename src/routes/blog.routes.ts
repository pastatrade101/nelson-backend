import { Router } from 'express';
import { createBlogPost, deleteBlogPost, getBlogPost, listBlogPosts, updateBlogPost } from '../controllers/blog.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { blogCreateSchema, blogUpdateSchema } from '../schemas/blog.schema';

const router = Router();

router.get('/', listBlogPosts);
router.get('/:slug', getBlogPost);
router.post('/', authenticate, requirePermission('blog.create'), validate({ body: blogCreateSchema }), createBlogPost);
router.put('/:id', authenticate, requirePermission('blog.update'), validate({ body: blogUpdateSchema }), updateBlogPost);
router.delete('/:id', authenticate, requirePermission('blog.delete'), deleteBlogPost);

export default router;
