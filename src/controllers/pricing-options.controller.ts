import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getPagination, getQueryString, paginationMeta } from '../utils/query';
import { GRID_BANDS, type PriceGridInput } from '../schemas/pricing-options.schema';
import { TIER_LABELS, TIER_ORDER } from '../utils/tiers';

const select = '*, tours(id,title,slug,duration_days,duration_nights,price_from,currency,status,destinations(name,slug,country))';

const normalizePayload = (payload: Record<string, unknown>) => {
  const normalized = { ...payload };
  const title = String(payload.title ?? payload.label ?? '').trim();

  if (title) {
    normalized.title = title;
    normalized.label = title;
  }

  if (payload.currency) normalized.currency = String(payload.currency).toUpperCase();
  if (!payload.price_type) normalized.price_type = 'per_person';

  return normalized;
};

export const listPricingOptions = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const tourId = getQueryString(req.query, 'tour_id');
  const priceType = getQueryString(req.query, 'price_type');

  let query = supabase
    .from('tour_price_options')
    .select(select, { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (tourId && tourId !== 'all') query = query.eq('tour_id', tourId);
  if (priceType && priceType !== 'all') query = query.eq('price_type', priceType);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch pricing options.', 500, [error]);

  return sendSuccess(res, 'Pricing options fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const listTourPricingOptions = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_price_options')
    .select(select)
    .eq('tour_id', req.params.tourId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Unable to fetch tour pricing options.', 500, [error]);

  return sendSuccess(res, 'Tour pricing options fetched successfully.', data ?? []);
});

export const getPricingOption = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_price_options')
    .select(select)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch pricing option.', 500, [error]);
  if (!data) throw new AppError('Pricing option not found.', 404);

  return sendSuccess(res, 'Pricing option fetched successfully.', data);
});

export const createPricingOption = asyncHandler(async (req, res) => {
  const payload = normalizePayload(req.body as Record<string, unknown>);

  const { data, error } = await supabase
    .from('tour_price_options')
    .insert(payload)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to create pricing option.', 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: 'tour_price_options', newData: data, req });

  return sendSuccess(res, 'Pricing option created successfully.', data, 201);
});

export const updatePricingOption = asyncHandler(async (req, res) => {
  const { data: previous, error: previousError } = await supabase
    .from('tour_price_options')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (previousError) throw new AppError('Unable to fetch pricing option.', 500, [previousError]);
  if (!previous) throw new AppError('Pricing option not found.', 404);

  const payload = normalizePayload(req.body as Record<string, unknown>);

  const { data, error } = await supabase
    .from('tour_price_options')
    .update(payload)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update pricing option.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'tour_price_options', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Pricing option updated successfully.', data);
});

export const deletePricingOption = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('tour_price_options')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  const { error } = await supabase.from('tour_price_options').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete pricing option.', 500, [error]);

  await safeAudit({ action: 'delete', entityId: req.params.id, entityType: 'tour_price_options', oldData: previous, req });

  return sendSuccess(res, 'Pricing option deleted successfully.');
});

const bandLabel = (from: number, to: number) =>
  from === to ? `${from} traveller${from === 1 ? '' : 's'}` : `${from}–${to} travellers`;

/**
 * Save a tour's whole price grid (comfort level x group size) in one request.
 *
 * Each comfort level with anything filled in is stored as one option per
 * group-size band, all carrying the level's lodges and child price, so the
 * tour page can read a cell straight off a row. A blank adult price is stored
 * as 0, which the site shows as "On request". A level left completely empty is
 * removed. Old-style options (no comfort level) are not touched.
 *
 * Rows are matched on (level, band) and updated in place, so ids stay stable
 * and a half-failed save never leaves duplicates behind.
 */
export const saveTourPriceGrid = asyncHandler(async (req, res) => {
  const tourId = req.params.tourId;
  const body = req.body as PriceGridInput;

  const { data: tour, error: tourError } = await supabase.from('tours').select('id').eq('id', tourId).maybeSingle();
  if (tourError) throw new AppError('Unable to fetch the tour.', 500, [tourError]);
  if (!tour) throw new AppError('Tour not found.', 404);

  const { data: existing, error: existingError } = await supabase
    .from('tour_price_options')
    .select('*')
    .eq('tour_id', tourId)
    .not('comfort_tier', 'is', null);
  if (existingError) throw new AppError('Unable to fetch the price grid. Has the price-grid SQL been run?', 500, [existingError]);

  const currency = (body.currency || 'USD').toUpperCase();
  const wanted: Record<string, unknown>[] = [];
  for (const tier of body.tiers) {
    const lodges = tier.lodges?.trim() || null;
    const childPrice = tier.child_price ?? null;
    const prices = new Map(tier.bands.map((band) => [`${band.travellers_from}-${band.travellers_to}`, band.price]));
    const hasContent = lodges || childPrice !== null || [...prices.values()].some((price) => price !== null && price > 0);
    if (!hasContent) continue;
    const rank = TIER_ORDER.indexOf(tier.comfort_tier);
    GRID_BANDS.forEach((band, index) => {
      const title = `${TIER_LABELS[tier.comfort_tier]} · ${bandLabel(band.from, band.to)}`;
      wanted.push({
        tour_id: tourId,
        comfort_tier: tier.comfort_tier,
        travellers_from: band.from,
        travellers_to: band.to,
        price: prices.get(`${band.from}-${band.to}`) ?? 0,
        child_price: childPrice,
        lodges,
        currency,
        price_type: 'per_person',
        title,
        label: title,
        sort_order: 100 + rank * 10 + index
      });
    });
  }

  const keyOf = (row: Record<string, unknown>) => `${row.comfort_tier}:${row.travellers_from}-${row.travellers_to}`;
  const byKey = new Map<string, Record<string, unknown>>();
  const extras: string[] = [];
  for (const row of (existing ?? []) as Record<string, unknown>[]) {
    if (byKey.has(keyOf(row))) extras.push(String(row.id));
    else byKey.set(keyOf(row), row);
  }

  const wantedKeys = new Set(wanted.map(keyOf));
  const toDelete = [
    ...extras,
    ...[...byKey.entries()].filter(([key]) => !wantedKeys.has(key)).map(([, row]) => String(row.id))
  ];

  for (const row of wanted) {
    const current = byKey.get(keyOf(row));
    const { error } = current
      ? await supabase.from('tour_price_options').update(row).eq('id', current.id as string)
      : await supabase.from('tour_price_options').insert(row);
    if (error) throw new AppError('Unable to save the price grid.', 500, [error]);
  }
  if (toDelete.length) {
    const { error } = await supabase.from('tour_price_options').delete().in('id', toDelete);
    if (error) throw new AppError('Unable to remove old grid prices.', 500, [error]);
  }

  const { data, error } = await supabase
    .from('tour_price_options')
    .select(select)
    .eq('tour_id', tourId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new AppError('Price grid saved, but it could not be read back.', 500, [error]);

  await safeAudit({
    action: 'update',
    entityId: tourId,
    entityType: 'tour_price_grid',
    oldData: { rows: existing ?? [] },
    newData: { rows: (data ?? []).filter((row: Record<string, unknown>) => row.comfort_tier) },
    req
  });

  return sendSuccess(res, 'Price grid saved.', data ?? []);
});
