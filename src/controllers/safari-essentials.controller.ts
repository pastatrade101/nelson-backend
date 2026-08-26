import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordById,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listSafariEssentials = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'safari_essentials',
    select: '*',
    searchColumns: ['title', 'summary', 'content', 'topic'],
    statusColumn: 'status',
    // Published-by-default matters here: every topic is seeded as a draft, so an
    // unfiltered list would serve nine empty articles to the public hub — the
    // exact thin-page outcome this feature is meant to avoid. The admin asks for
    // `?status=all` (or a specific status) to see drafts.
    defaultStatus: 'published',
    // Ordered editorially rather than by date — these are evergreen guides, so
    // "newest first" would be meaningless.
    orderBy: 'sort_order',
    ascending: true,
    // `country` is how the hub scopes itself, so a Kenya hub needs no new code.
    filters: ['country', 'topic']
  });
});

export const getSafariEssential = asyncHandler(async (req, res) => {
  const key = req.params.slug;
  if (uuidPattern.test(key)) return getRecordById(res, 'safari_essentials', key, '*');
  return getRecordBySlug(res, 'safari_essentials', key, '*');
});

export const createSafariEssential = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'safari_essentials', req.body, { slugSource: 'title' });
});

export const updateSafariEssential = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'safari_essentials', req.params.id, req.body, { slugSource: 'title' });
});

export const deleteSafariEssential = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'safari_essentials', req.params.id);
});
