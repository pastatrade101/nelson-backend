import { asyncHandler } from '../utils/async-handler';
import { createRecord, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

export const listMedia = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'media_library',
    searchColumns: ['file_name', 'alt_text', 'caption', 'mime_type'],
    filters: ['file_type', 'uploaded_by']
  });
});

export const createMedia = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'media_library', {
    ...req.body,
    uploaded_by: req.user?.sub ?? null
  });
});

export const updateMedia = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'media_library', req.params.id, req.body);
});

export const deleteMedia = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'media_library', req.params.id, req);
});
