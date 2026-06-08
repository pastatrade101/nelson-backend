import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordById,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const select = '*, blog_categories(id,name,slug)';

export const listBlogPosts = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'blog_posts',
    select,
    searchColumns: ['title', 'excerpt', 'content', 'author_name'],
    statusColumn: 'status',
    filters: ['category_id']
  });
});

export const getBlogPost = asyncHandler(async (req, res) => {
  const key = req.params.slug;
  if (uuidPattern.test(key)) return getRecordById(res, 'blog_posts', key, select);
  return getRecordBySlug(res, 'blog_posts', key, select);
});

export const createBlogPost = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'blog_posts', req.body, { slugSource: 'title' });
});

export const updateBlogPost = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'blog_posts', req.params.id, req.body, { slugSource: 'title' });
});

export const deleteBlogPost = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'blog_posts', req.params.id);
});
