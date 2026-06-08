import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getPagination, getQueryString, paginationMeta } from '../utils/query';

const select = '*, tours(id,title,slug,status)';

export const listInclusions = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const tourId = getQueryString(req.query, 'tour_id');

  let query = supabase
    .from('tour_inclusions')
    .select(select, { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (tourId && tourId !== 'all') query = query.eq('tour_id', tourId);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch tour inclusions.', 500, [error]);

  return sendSuccess(res, 'Tour inclusions fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const listTourInclusions = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_inclusions')
    .select(select)
    .eq('tour_id', req.params.tourId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Unable to fetch tour inclusions.', 500, [error]);

  return sendSuccess(res, 'Tour inclusions fetched successfully.', data ?? []);
});

export const getInclusion = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_inclusions')
    .select(select)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch tour inclusion.', 500, [error]);
  if (!data) throw new AppError('Tour inclusion not found.', 404);

  return sendSuccess(res, 'Tour inclusion fetched successfully.', data);
});

export const createInclusion = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_inclusions')
    .insert(req.body)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to create tour inclusion.', 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: 'tour_inclusions', newData: data, req });

  return sendSuccess(res, 'Tour inclusion created successfully.', data, 201);
});

export const updateInclusion = asyncHandler(async (req, res) => {
  const { data: previous, error: prevError } = await supabase
    .from('tour_inclusions')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (prevError) throw new AppError('Unable to fetch tour inclusion.', 500, [prevError]);
  if (!previous) throw new AppError('Tour inclusion not found.', 404);

  const { data, error } = await supabase
    .from('tour_inclusions')
    .update(req.body)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update tour inclusion.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'tour_inclusions', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Tour inclusion updated successfully.', data);
});

export const deleteInclusion = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('tour_inclusions')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  const { error } = await supabase.from('tour_inclusions').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete tour inclusion.', 500, [error]);

  await safeAudit({ action: 'delete', entityId: req.params.id, entityType: 'tour_inclusions', oldData: previous, req });

  return sendSuccess(res, 'Tour inclusion deleted successfully.');
});
