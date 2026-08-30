import { AppError, sendSuccess } from '../utils/api-response';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

const select = '*, destinations(name,slug)';
// The detail view adds the property's gallery. Falls back below when the table
// is absent, so a pending migration hides the gallery rather than 404ing the page.
const detailSelect = `${select}, lodge_images(id,image_url,alt_text,caption,sort_order,is_cover)`;

/**
 * The itineraries that actually stay at this property.
 *
 * Uses the day → property link rather than the destination, so the list is
 * "trips that sleep here" instead of "trips that pass through the same park".
 * An inner join on itinerary_days does the filtering; a tour with no matching
 * day simply is not returned.
 *
 * Returns an empty list — never an error — when the link column is missing,
 * because the caller falls back to destination-mates and a 500 here would take
 * the whole property page down over a section that is decoration.
 */
export const listLodgeItineraries = asyncHandler(async (req, res) => {
  const lodgeId = req.params.id;

  const { data, error } = await supabase
    .from('tours')
    .select(
      'id,title,slug,short_description,duration_days,duration_nights,price_from,currency,main_image_url,banner_image_url,budget_tier,persona_tags,is_featured,is_popular,status,destinations(name,slug),tour_categories(name,slug),itinerary_days!inner(accommodation_id)'
    )
    .eq('itinerary_days.accommodation_id', lodgeId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .limit(24);

  if (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PGRST200' || code === '42703') {
      return sendSuccess(res, 'Itineraries fetched successfully.', { items: [] });
    }
    throw new AppError('Unable to fetch itineraries for this property.', 500, [error]);
  }

  // The inner join repeats a tour once per matching day; collapse to one card
  // each and drop the join column from the payload.
  const seen = new Set<string>();
  const items = (data ?? []).filter((row) => {
    const id = String((row as { id?: unknown }).id ?? '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    delete (row as Record<string, unknown>).itinerary_days;
    return true;
  });

  return sendSuccess(res, 'Itineraries fetched successfully.', { items });
});

export const listLodges = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'lodges',
    select,
    searchColumns: ['name', 'description', 'why_we_recommend'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['destination_id', 'accommodation_level', 'lodge_type', 'is_featured']
  });
});

export const getLodge = asyncHandler(async (req, res) => {
  // Try with the gallery; fall back without it when lodge_images does not exist
  // yet. PostgREST rejects the whole query on an unresolvable embed, so without
  // this a pending migration would 500 every property page.
  const { data, error } = await supabase
    .from('lodges')
    .select(detailSelect)
    .eq('slug', req.params.slug)
    .is('deleted_at', null)
    .maybeSingle();

  if (error && ((error as { code?: string }).code === 'PGRST200' || (error as { code?: string }).code === '42P01')) {
    return getRecordBySlug(res, 'lodges', req.params.slug, select);
  }
  if (error) throw new AppError('Unable to fetch lodges.', 500, [error]);
  if (!data) throw new AppError('Record not found.', 404);

  return sendSuccess(res, 'Record fetched successfully.', data);
});

export const createLodge = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'lodges', req.body, { slugSource: 'name', userFields: true });
});

export const updateLodge = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'lodges', req.params.id, req.body, { slugSource: 'name', userFields: true });
});

export const deleteLodge = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'lodges', req.params.id, req);
});
