import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getPagination, getQueryString, paginationMeta } from '../utils/query';

const select = '*, tours(id,title,slug,status)';

export const listExclusions = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const tourId = getQueryString(req.query, 'tour_id');

  let query = supabase
    .from('tour_exclusions')
    .select(select, { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (tourId && tourId !== 'all') query = query.eq('tour_id', tourId);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch tour exclusions.', 500, [error]);

  return sendSuccess(res, 'Tour exclusions fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const listTourExclusions = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_exclusions')
    .select(select)
    .eq('tour_id', req.params.tourId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Unable to fetch tour exclusions.', 500, [error]);

  return sendSuccess(res, 'Tour exclusions fetched successfully.', data ?? []);
});

export const getExclusion = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_exclusions')
    .select(select)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch tour exclusion.', 500, [error]);
  if (!data) throw new AppError('Tour exclusion not found.', 404);

  return sendSuccess(res, 'Tour exclusion fetched successfully.', data);
});

export const createExclusion = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_exclusions')
    .insert(req.body)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to create tour exclusion.', 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: 'tour_exclusions', newData: data, req });

  return sendSuccess(res, 'Tour exclusion created successfully.', data, 201);
});

export const updateExclusion = asyncHandler(async (req, res) => {
  const { data: previous, error: prevError } = await supabase
    .from('tour_exclusions')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (prevError) throw new AppError('Unable to fetch tour exclusion.', 500, [prevError]);
  if (!previous) throw new AppError('Tour exclusion not found.', 404);

  const { data, error } = await supabase
    .from('tour_exclusions')
    .update(req.body)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update tour exclusion.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'tour_exclusions', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Tour exclusion updated successfully.', data);
});

export const deleteExclusion = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('tour_exclusions')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  const { error } = await supabase.from('tour_exclusions').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete tour exclusion.', 500, [error]);

  await safeAudit({ action: 'delete', entityId: req.params.id, entityType: 'tour_exclusions', oldData: previous, req });

  return sendSuccess(res, 'Tour exclusion deleted successfully.');
});
