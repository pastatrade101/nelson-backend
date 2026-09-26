import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { cleanSearch, getPagination, getQueryString, paginationMeta } from '../utils/query';

const select = '*, tours(id,title,slug,duration_days,duration_nights,status,destinations(name,slug,country))';

// The catalogue activities linked to each day, so the admin editor can show
// which are ticked. Requires the 2026-09-26 migration; see the fallback below.
const selectWithActivities =
  `${select}, day_activities:itinerary_day_activities(sort_order,activity:activities(id,name,slug,category,duration_label,price_from,currency,price_unit,badge,hero_image_url,image_url,status))`;

/**
 * PostgREST rejects the WHOLE query when an embed cannot be resolved, so on a
 * database that has not had the join-table migration this would take the
 * entire day editor down rather than merely hide the activity picker. Retry
 * without the embed on that specific error, matching tours.controller.
 */
const isMissingEmbed = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === 'PGRST200' || code === '42P01';
};

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
  const fetchWith = (sel: string) =>
    supabase
      .from('itinerary_days')
      .select(sel)
      .eq('tour_id', req.params.tourId)
      .order('day_number', { ascending: true })
      .order('created_at', { ascending: true });

  let { data, error } = await fetchWith(selectWithActivities);
  if (error && isMissingEmbed(error)) ({ data, error } = await fetchWith(select));

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

/**
 * Replace the catalogue activities linked to one itinerary day.
 *
 * Replace rather than diff: the editor hands back the whole list in the order
 * the user arranged it, so the order IS the payload. Delete-then-insert keeps
 * that honest and cannot leave a stale row behind.
 *
 * The day's free-text `activities` column is untouched — the two coexist, and
 * the public page shows whichever is present.
 */
export const setDayActivities = asyncHandler(async (req, res) => {
  const dayId = req.params.id;
  const ids = Array.isArray(req.body?.activity_ids)
    ? (req.body.activity_ids as unknown[]).map(String).filter(Boolean)
    : [];

  const { data: day } = await supabase.from('itinerary_days').select('id').eq('id', dayId).maybeSingle();
  if (!day) throw new AppError('Itinerary day not found.', 404);

  const { error: clearError } = await supabase.from('itinerary_day_activities').delete().eq('day_id', dayId);
  if (clearError) throw new AppError('Unable to update the day\u2019s activities.', 500, [clearError]);

  if (ids.length) {
    // De-duplicated: the table has a unique (day_id, activity_id) and sending
    // the same activity twice is a mistake rather than something to persist.
    const rows = [...new Set(ids)].map((activity_id, sort_order) => ({ day_id: dayId, activity_id, sort_order }));
    const { error } = await supabase.from('itinerary_day_activities').insert(rows);
    if (error) throw new AppError('Unable to link those activities.', 500, [error]);
  }

  const { data } = await supabase
    .from('itinerary_day_activities')
    .select('sort_order, activity:activities(id,name,slug,category,duration_label,price_from,currency,badge,hero_image_url,image_url)')
    .eq('day_id', dayId)
    .order('sort_order');

  return sendSuccess(res, 'Day activities updated.', { activities: data ?? [] });
});
