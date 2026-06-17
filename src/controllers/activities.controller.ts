import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

const select = '*, destinations(name,slug)';

export const listActivities = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'activities',
    select,
    searchColumns: ['name', 'description', 'why_we_recommend', 'location_label'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['destination_id', 'category', 'difficulty', 'is_featured']
  });
});

export const getActivity = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'activities', req.params.slug, select);
});

export const createActivity = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'activities', req.body, { slugSource: 'name', userFields: true });
});

export const updateActivity = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'activities', req.params.id, req.body, { slugSource: 'name', userFields: true });
});

export const deleteActivity = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'activities', req.params.id, req);
});
