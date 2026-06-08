import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getPagination, getQueryString, paginationMeta } from '../utils/query';

const select = '*, tours(id,title,slug,duration_days,duration_nights,price_from,currency,status,destinations(name,slug,country))';

const normalizePayload = (payload: Record<string, unknown>) => {
  const normalized = { ...payload };
  if (payload.currency) normalized.currency = String(payload.currency).toUpperCase();
  return normalized;
};

export const listAvailableDates = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const tourId = getQueryString(req.query, 'tour_id');
  const status = getQueryString(req.query, 'status');

  let query = supabase
    .from('available_dates')
    .select(select, { count: 'exact' })
    .order('start_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (tourId && tourId !== 'all') query = query.eq('tour_id', tourId);
  if (status && status !== 'all') query = query.eq('status', status);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch available dates.', 500, [error]);

  return sendSuccess(res, 'Available dates fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const listTourAvailableDates = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('available_dates')
    .select(select)
    .eq('tour_id', req.params.tourId)
    .order('start_date', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Unable to fetch tour available dates.', 500, [error]);

  return sendSuccess(res, 'Tour available dates fetched successfully.', data ?? []);
});

export const getAvailableDate = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('available_dates')
    .select(select)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch available date.', 500, [error]);
  if (!data) throw new AppError('Available date not found.', 404);

  return sendSuccess(res, 'Available date fetched successfully.', data);
});

export const createAvailableDate = asyncHandler(async (req, res) => {
  const payload = normalizePayload(req.body as Record<string, unknown>);

  const { data, error } = await supabase
    .from('available_dates')
    .insert(payload)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to create available date.', 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: 'available_dates', newData: data, req });

  return sendSuccess(res, 'Available date created successfully.', data, 201);
});

export const updateAvailableDate = asyncHandler(async (req, res) => {
  const { data: previous, error: previousError } = await supabase
    .from('available_dates')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (previousError) throw new AppError('Unable to fetch available date.', 500, [previousError]);
  if (!previous) throw new AppError('Available date not found.', 404);

  const payload = normalizePayload(req.body as Record<string, unknown>);
  const startDate = String(payload.start_date ?? previous.start_date);
  const endDate = payload.end_date === undefined ? previous.end_date : payload.end_date;

  if (endDate && String(endDate) < startDate) {
    throw new AppError('End date must not be before start date.', 400);
  }

  const { data, error } = await supabase
    .from('available_dates')
    .update(payload)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update available date.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'available_dates', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Available date updated successfully.', data);
});

export const deleteAvailableDate = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('available_dates')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  const { error } = await supabase.from('available_dates').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete available date.', 500, [error]);

  await safeAudit({ action: 'delete', entityId: req.params.id, entityType: 'available_dates', oldData: previous, req });

  return sendSuccess(res, 'Available date deleted successfully.');
});
