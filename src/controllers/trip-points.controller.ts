import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

const select = '*, destinations(name,slug)';

export const listTripPoints = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'trip_points',
    select,
    searchColumns: ['name', 'description', 'transfer_info', 'airport_code'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['destination_id', 'role', 'gateway_type', 'is_featured']
  });
});

export const getTripPoint = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'trip_points', req.params.slug, select);
});

export const createTripPoint = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'trip_points', req.body, { slugSource: 'name', userFields: true });
});

export const updateTripPoint = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'trip_points', req.params.id, req.body, { slugSource: 'name', userFields: true });
});

export const deleteTripPoint = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'trip_points', req.params.id, req);
});
