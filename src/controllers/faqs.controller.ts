import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordById, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const select = '*, destinations(name,slug)';

export const listFaqs = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'faqs',
    select,
    searchColumns: ['question', 'answer', 'category'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['category', 'destination_id'],
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getFaq = asyncHandler(async (req, res) => {
  return getRecordById(res, 'faqs', req.params.id, select);
});

export const createFaq = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'faqs', req.body);
});

export const updateFaq = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'faqs', req.params.id, req.body);
});

export const deleteFaq = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'faqs', req.params.id, req);
});
