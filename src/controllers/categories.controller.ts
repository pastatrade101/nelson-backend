import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordBySlug, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

export const listCategories = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'tour_categories',
    searchColumns: ['name', 'description'],
    statusColumn: 'status',
    defaultStatus: 'published',
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getCategory = asyncHandler(async (req, res) => getRecordBySlug(res, 'tour_categories', req.params.slug));

export const createCategory = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'tour_categories', req.body, { slugSource: 'name' });
});

export const updateCategory = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'tour_categories', req.params.id, req.body, { slugSource: 'name' });
});

export const deleteCategory = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'tour_categories', req.params.id, req);
});
