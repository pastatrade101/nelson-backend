import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordById, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const select = '*';

export const listSpecialists = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'specialists',
    select,
    searchColumns: ['name', 'role', 'blurb'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['is_featured'],
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getSpecialist = asyncHandler(async (req, res) => {
  return getRecordById(res, 'specialists', req.params.id, select);
});

export const createSpecialist = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'specialists', req.body);
});

export const updateSpecialist = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'specialists', req.params.id, req.body);
});

export const deleteSpecialist = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'specialists', req.params.id, req);
});
