import { supabase } from '../config/supabase';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getQueryString } from '../utils/query';
import { createRecord, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const TABLE = 'market_pages';

export const listMarketPages = asyncHandler(async (req, res) => {
  // Public callers see published pages only; `?all=true` (the admin list) returns
  // every status — the same opt-in the homepage endpoint uses. An explicit
  // `?status=` still wins so the admin can filter to one status.
  const includeAllStatuses = getQueryString(req.query, 'all') === 'true';
  if (includeAllStatuses && !getQueryString(req.query, 'status')) req.query.status = 'all';

  return listRecords(req, res, {
    table: TABLE,
    searchColumns: ['name', 'slug', 'hero_title', 'meta_title'],
    statusColumn: 'status',
    defaultStatus: 'published',
    orderBy: 'sort_order',
    ascending: true
  });
});

export const getMarketPageBySlug = asyncHandler(async (req, res) => {
  // Not the shared getRecordBySlug helper: a market page must also be gated on
  // status, so an unpublished market stays a 404 for the public while the admin
  // (and its preview) can still load a draft with `?all=true`.
  const includeAllStatuses = getQueryString(req.query, 'all') === 'true';

  let query = supabase.from(TABLE).select('*').eq('slug', req.params.slug).is('deleted_at', null);
  if (!includeAllStatuses) query = query.eq('status', 'published');

  const { data, error } = await query.maybeSingle();
  if (error) throw new AppError(`Unable to fetch ${TABLE}.`, 500, [error]);
  if (!data) throw new AppError('Record not found.', 404);

  return sendSuccess(res, 'Record fetched successfully.', data);
});

export const createMarketPage = asyncHandler(async (req, res) => {
  // slugSource 'name' is the fallback only: createUniqueSlug keeps a supplied
  // slug ('tanzania-safari-from-dubai') and just guarantees it is unique.
  return createRecord(req, res, TABLE, req.body, { slugSource: 'name', userFields: true });
});

export const updateMarketPage = asyncHandler(async (req, res) => {
  return updateRecord(req, res, TABLE, req.params.id, req.body, { slugSource: 'name', userFields: true });
});

export const deleteMarketPage = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, TABLE, req.params.id, req);
});
