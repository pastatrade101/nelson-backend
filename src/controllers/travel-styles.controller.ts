import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

export const listTravelStyles = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'travel_styles',
    searchColumns: ['name', 'description', 'emotional_promise'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['persona', 'is_featured']
  });
});

export const getTravelStyle = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'travel_styles', req.params.slug);
});

export const createTravelStyle = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'travel_styles', req.body, { slugSource: 'name', userFields: true });
});

export const updateTravelStyle = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'travel_styles', req.params.id, req.body, { slugSource: 'name', userFields: true });
});

export const deleteTravelStyle = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'travel_styles', req.params.id, req);
});
