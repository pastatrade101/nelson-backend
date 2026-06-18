import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

export const listComparisons = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'comparisons',
    searchColumns: ['title', 'intro', 'a_name', 'b_name'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['is_featured']
  });
});

export const getComparison = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'comparisons', req.params.slug);
});

export const createComparison = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'comparisons', req.body, { slugSource: 'title', userFields: true });
});

export const updateComparison = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'comparisons', req.params.id, req.body, { slugSource: 'title', userFields: true });
});

export const deleteComparison = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'comparisons', req.params.id, req);
});
