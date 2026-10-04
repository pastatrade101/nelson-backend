import { supabase } from '../config/supabase';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { createRecord, deleteRecord, getRecordById, listRecords, updateRecord } from '../utils/supabase-helpers';
import { getQueryString } from '../utils/query';

const table = 'page_seo';

const normalizePath = (value: string): string => {
  const clean = value.trim();
  if (clean === '/') return clean;
  return clean.replace(/\/+$/, '') || '/';
};

const ensurePathIsAvailable = async (path: string, currentId?: string): Promise<void> => {
  const { data, error } = await supabase.from(table).select('id').eq('path', path).maybeSingle();
  if (error) throw new AppError('Unable to validate the SEO path.', 500, [error]);
  if (data && data.id !== currentId) {
    throw new AppError('An SEO override already exists for this path.', 409);
  }
};

export const listPageSeo = asyncHandler(async (req, res) =>
  listRecords(req, res, {
    table,
    searchColumns: ['path', 'title', 'meta_description'],
    softDelete: false,
    orderBy: 'path',
    ascending: true
  })
);

export const getPageSeo = asyncHandler(async (req, res) => getRecordById(res, table, req.params.id));

export const createPageSeo = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const path = normalizePath(String(body.path ?? ''));
  await ensurePathIsAvailable(path);
  return createRecord(req, res, table, { ...body, path });
});

export const updatePageSeo = asyncHandler(async (req, res) => {
  const body = req.body as Record<string, unknown>;
  const payload = body.path === undefined ? body : { ...body, path: normalizePath(String(body.path)) };
  if (typeof payload.path === 'string') await ensurePathIsAvailable(payload.path, req.params.id);
  return updateRecord(req, res, table, req.params.id, payload);
});

export const deletePageSeo = asyncHandler(async (req, res) => deleteRecord(res, table, req.params.id, req));

// Public and deliberately small: the site shell asks for one path at a time.
// An absent row is a normal case, not an error; it simply keeps the route's
// tested editorial defaults.
export const resolvePageSeo = asyncHandler(async (req, res) => {
  const requestedPath = getQueryString(req.query, 'path');
  if (!requestedPath) return sendSuccess(res, 'No SEO override matched.', { match: false });

  const path = normalizePath(requestedPath);
  const { data, error } = await supabase
    .from(table)
    .select('path,title,meta_description,og_title,og_description,og_image_url,canonical_url,robots,structured_data')
    .eq('is_active', true)
    .eq('path', path)
    .maybeSingle();

  if (error) throw new AppError('Unable to resolve page SEO.', 500, [error]);
  return sendSuccess(res, data ? 'SEO override matched.' : 'No SEO override matched.', data ? { match: true, seo: data } : { match: false });
});

// The sitemap needs only indexing directives and canonical targets. Publishing
// this narrow projection keeps it useful without exposing the editor's full
// metadata payload.
export const listPageSeoIndexingRules = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from(table)
    .select('path,canonical_url,robots')
    .eq('is_active', true)
    .order('path', { ascending: true });

  if (error) throw new AppError('Unable to fetch page SEO indexing rules.', 500, [error]);
  return sendSuccess(res, 'Page SEO indexing rules fetched successfully.', data ?? []);
});
