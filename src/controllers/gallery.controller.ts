import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordById, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const select = '*, destinations(id,name,slug), tours(id,title,slug)';

export const listGalleryImages = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'gallery_images',
    select,
    searchColumns: ['title', 'alt_text', 'caption'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['destination_id', 'tour_id', 'media_type'],
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getGalleryImage = asyncHandler(async (req, res) => {
  return getRecordById(res, 'gallery_images', req.params.id, select);
});

export const createGalleryImage = asyncHandler(async (req, res) => {
  const body = { ...req.body, created_by: req.user?.sub ?? null };
  return createRecord(req, res, 'gallery_images', body);
});

export const updateGalleryImage = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'gallery_images', req.params.id, req.body);
});

export const deleteGalleryImage = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'gallery_images', req.params.id, req);
});
