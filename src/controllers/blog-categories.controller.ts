import { asyncHandler } from '../utils/async-handler';
import { createRecord, deleteRecord, getRecordById, getRecordBySlug, listRecords, updateRecord } from '../utils/supabase-helpers';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listBlogCategories = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'blog_categories',
    searchColumns: ['name', 'description'],
    statusColumn: 'status',
    softDelete: false,
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getBlogCategory = asyncHandler(async (req, res) => {
  const key = req.params.slug;
  if (uuidPattern.test(key)) return getRecordById(res, 'blog_categories', key);
  return getRecordBySlug(res, 'blog_categories', key);
});

export const createBlogCategory = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'blog_categories', req.body, { slugSource: 'name' });
});

export const updateBlogCategory = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'blog_categories', req.params.id, req.body, { slugSource: 'name' });
});

export const deleteBlogCategory = asyncHandler(async (req, res) => {
  return deleteRecord(res, 'blog_categories', req.params.id, req);
});
