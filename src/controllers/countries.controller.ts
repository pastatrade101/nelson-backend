import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

export const listCountries = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'countries',
    searchColumns: ['name', 'capital', 'currency', 'intro_text'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['phase', 'is_featured']
  });
});

export const getCountry = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'countries', req.params.slug);
});

export const createCountry = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'countries', req.body, { slugSource: 'name', userFields: true });
});

export const updateCountry = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'countries', req.params.id, req.body, { slugSource: 'name', userFields: true });
});

export const deleteCountry = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'countries', req.params.id, req);
});
