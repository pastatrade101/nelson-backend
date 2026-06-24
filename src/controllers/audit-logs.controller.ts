import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { cleanSearch, getPagination, getQueryString, paginationMeta } from '../utils/query';
import { getRecordById } from '../utils/supabase-helpers';

const select = '*, admin_users(full_name,email,role)';

export const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const search = cleanSearch(getQueryString(req.query, 'search'));

  let query = supabase
    .from('audit_logs')
    .select(select, { count: 'exact' })
    .order('created_at', { ascending: false });

  if (search) {
    query = query.or(['action', 'entity_type', 'entity_id'].map((c) => `${c}.ilike.%${search}%`).join(','));
  }

  for (const column of ['action', 'entity_type', 'admin_user_id']) {
    const value = getQueryString(req.query, column);
    if (value && value !== 'all') query = query.eq(column, value);
  }

  const createdFrom = getQueryString(req.query, 'created_from');
  const createdTo = getQueryString(req.query, 'created_to');
  if (createdFrom) query = query.gte('created_at', createdFrom);
  if (createdTo) query = query.lte('created_at', `${createdTo}T23:59:59`);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch audit logs.', 500, [error]);

  return sendSuccess(res, 'Audit logs fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const getAuditLog = asyncHandler(async (req, res) => getRecordById(res, 'audit_logs', req.params.id, select));

// Filter options for the UI: distinct entity types (from recent rows) + actors.
export const getAuditFacets = asyncHandler(async (_req, res) => {
  let entityTypes: string[] = [];
  try {
    const { data } = await supabase
      .from('audit_logs')
      .select('entity_type')
      .order('created_at', { ascending: false })
      .limit(3000);
    entityTypes = [...new Set((data ?? []).map((r) => r.entity_type as string).filter(Boolean))].sort();
  } catch {
    entityTypes = [];
  }

  let actors: Array<{ id: string; name: string }> = [];
  try {
    const { data } = await supabase.from('admin_users').select('id, full_name, email').order('full_name');
    actors = (data ?? []).map((u) => ({
      id: u.id as string,
      name: (u.full_name as string) || (u.email as string) || 'Unknown'
    }));
  } catch {
    actors = [];
  }

  return sendSuccess(res, 'Audit facets fetched.', { entityTypes, actors });
});
