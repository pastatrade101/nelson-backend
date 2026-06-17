import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

export const listSafetyTopics = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'safety_topics',
    searchColumns: ['title', 'summary', 'content'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['category', 'is_featured']
  });
});

export const getSafetyTopic = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'safety_topics', req.params.slug);
});

export const createSafetyTopic = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'safety_topics', req.body, { slugSource: 'title', userFields: true });
});

export const updateSafetyTopic = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'safety_topics', req.params.id, req.body, { slugSource: 'title', userFields: true });
});

export const deleteSafetyTopic = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'safety_topics', req.params.id, req);
});
