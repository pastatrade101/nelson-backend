import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { cleanSearch, getPagination, getQueryString, paginationMeta } from '../utils/query';

const select = '*, tours(id,title,slug,duration_days,duration_nights,status,destinations(name,slug,country))';

const duplicateDayExists = async (tourId: string, dayNumber: number, excludeId?: string) => {
  let query = supabase
    .from('itinerary_days')
    .select('id')
    .eq('tour_id', tourId)
    .eq('day_number', dayNumber);

  if (excludeId) query = query.neq('id', excludeId);

  const { data, error } = await query.maybeSingle();
  if (error) throw new AppError('Unable to validate itinerary day.', 500, [error]);

  return Boolean(data);
};

export const listItineraries = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const tourId = getQueryString(req.query, 'tour_id');
  const search = cleanSearch(getQueryString(req.query, 'search'));

  let query = supabase
    .from('itinerary_days')
    .select(select, { count: 'exact' })
    .order('day_number', { ascending: true })
    .order('created_at', { ascending: true });

  if (tourId && tourId !== 'all') query = query.eq('tour_id', tourId);
  if (search) {
    query = query.or(
      ['title', 'description', 'accommodation', 'meals', 'activities']
        .map((column) => `${column}.ilike.%${search}%`)
        .join(',')
    );
  }

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch itinerary days.', 500, [error]);

  return sendSuccess(res, 'Itinerary days fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const listTourItineraries = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('itinerary_days')
    .select(select)
    .eq('tour_id', req.params.tourId)
    .order('day_number', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Unable to fetch tour itinerary days.', 500, [error]);

  return sendSuccess(res, 'Tour itinerary days fetched successfully.', data ?? []);
});

export const getItinerary = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('itinerary_days')
    .select(select)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch itinerary day.', 500, [error]);
  if (!data) throw new AppError('Itinerary day not found.', 404);

  return sendSuccess(res, 'Itinerary day fetched successfully.', data);
});

export const createItinerary = asyncHandler(async (req, res) => {
  const payload = req.body as Record<string, unknown> & { day_number: number; tour_id: string };

  if (await duplicateDayExists(payload.tour_id, payload.day_number)) {
    throw new AppError('This tour already has an itinerary day with that day number.', 409);
  }

  const { data, error } = await supabase
    .from('itinerary_days')
    .insert(payload)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to create itinerary day.', 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: 'itinerary_days', newData: data, req });

  return sendSuccess(res, 'Itinerary day created successfully.', data, 201);
});

export const updateItinerary = asyncHandler(async (req, res) => {
  const { data: previous, error: previousError } = await supabase
    .from('itinerary_days')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (previousError) throw new AppError('Unable to fetch itinerary day.', 500, [previousError]);
  if (!previous) throw new AppError('Itinerary day not found.', 404);

  const payload = req.body as Record<string, unknown>;
  const tourId = String(payload.tour_id ?? previous.tour_id);
  const dayNumber = Number(payload.day_number ?? previous.day_number);

  if (await duplicateDayExists(tourId, dayNumber, req.params.id)) {
    throw new AppError('This tour already has an itinerary day with that day number.', 409);
  }

  const { data, error } = await supabase
    .from('itinerary_days')
    .update(payload)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update itinerary day.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'itinerary_days', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Itinerary day updated successfully.', data);
});

export const deleteItinerary = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('itinerary_days')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  const { error } = await supabase.from('itinerary_days').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete itinerary day.', 500, [error]);

  await safeAudit({ action: 'delete', entityId: req.params.id, entityType: 'itinerary_days', oldData: previous, req });

  return sendSuccess(res, 'Itinerary day deleted successfully.');
});
