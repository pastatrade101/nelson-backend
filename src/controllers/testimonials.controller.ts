import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordById, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const select = '*, tours(id,title,slug)';

export const listTestimonials = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'testimonials',
    select,
    searchColumns: ['client_name', 'client_country', 'message'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['tour_id', 'is_featured', 'rating'],
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getTestimonial = asyncHandler(async (req, res) => {
  return getRecordById(res, 'testimonials', req.params.id, select);
});

export const createTestimonial = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'testimonials', req.body);
});

export const updateTestimonial = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'testimonials', req.params.id, req.body);
});

export const deleteTestimonial = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'testimonials', req.params.id, req);
});
