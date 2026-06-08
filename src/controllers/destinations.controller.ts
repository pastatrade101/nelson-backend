import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

export const listDestinations = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'destinations',
    searchColumns: ['name', 'country', 'region', 'location', 'short_description', 'description'],
    statusColumn: 'status',
    defaultStatus: 'published'
  });
});

export const getDestination = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'destinations', req.params.slug);
});

export const createDestination = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'destinations', req.body, { slugSource: 'name' });
});

export const updateDestination = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'destinations', req.params.id, req.body, { slugSource: 'name' });
});

export const deleteDestination = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'destinations', req.params.id, req);
});
