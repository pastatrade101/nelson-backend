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

/**
 * The countries we actually run trips in — distinct `country` values across
 * published destinations.
 *
 * Small and cheap on purpose: the site layout calls this on every render to
 * decide which country hubs to link, so it returns a handful of strings rather
 * than the destination rows themselves.
 */
export const listDestinationCountries = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('destinations')
    .select('country')
    .is('deleted_at', null)
    .eq('status', 'published')
    .not('country', 'is', null);

  if (error) throw new AppError('Unable to fetch destination countries.', 500, [error]);

  const countries = [...new Set((data ?? []).map((row) => String(row.country ?? '').trim()).filter(Boolean))].sort();

  return sendSuccess(res, 'Countries fetched successfully.', { countries });
});

export const listDestinations = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'destinations',
    // Lean projection for listings: exclude the large `guide` jsonb (and other
    // detail-only fields) so a list of destinations isn't ~50KB/row. The full
    // guide is still returned by the get-by-slug detail endpoint.
    select:
      'id, name, slug, country, region, location, short_description, description, image_url, main_image_url, banner_image_url, latitude, longitude, score_wildlife, score_luxury, score_family, score_photography, score_adventure, score_budget_from, status, is_featured, meta_title, meta_description, og_image_url, updated_at',
    searchColumns: ['name', 'country', 'region', 'location', 'short_description', 'description'],
    statusColumn: 'status',
    defaultStatus: 'published',
    // Lets a country hub ask for just its own destinations.
    filters: ['country']
  });
});

export const getDestination = asyncHandler(async (req, res) => {
  return getRecordBySlug(res, 'destinations', req.params.slug);
});

export const createDestination = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'destinations', req.body, { slugSource: 'name' });
});

export const updateDestination = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'destinations', req.params.id, req.body, { slugSource: 'name' });
});

export const deleteDestination = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'destinations', req.params.id, req);
});

/**
 * Published tours connected to a destination, through the data model only:
 *   - `destination`: the tour's own destination is this one;
 *   - `stays`: one of its itinerary days sleeps at a lodge in this destination
 *     (itinerary_days.accommodation_id -> lodges.destination_id).
 * Destination matches come first. Each item carries `match` so the page can
 * word the two differently. Read-only and public, like the tour list.
 */
const DESTINATION_TOUR_FIELDS =
  'id,title,slug,short_description,duration_days,duration_nights,price_from,currency,main_image_url,banner_image_url,budget_tier,persona_tags,is_featured,is_popular,status,destinations(name,slug),tour_categories(name,slug)';

export const listDestinationTours = asyncHandler(async (req, res) => {
  const destinationId = String(req.params.id ?? '');
  const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 48);

  const { data: direct, error } = await supabase
    .from('tours')
    .select(DESTINATION_TOUR_FIELDS)
    .eq('destination_id', destinationId)
    .eq('status', 'published')
    .is('deleted_at', null)
    .order('is_featured', { ascending: false })
    .limit(limit);
  if (error) throw new AppError('Unable to fetch tours for this destination.', 500, [error]);

  const seen = new Set<string>();
  const items: Record<string, unknown>[] = [];
  for (const row of (direct ?? []) as Record<string, unknown>[]) {
    seen.add(String(row.id));
    items.push({ ...row, match: 'destination' });
  }

  // Tours that stay at this destination's lodges. Best-effort: on a database
  // without the day -> lodge link this simply adds nothing.
  if (items.length < limit) {
    const { data: lodges } = await supabase
      .from('lodges')
      .select('id')
      .eq('destination_id', destinationId)
      .eq('status', 'published')
      .is('deleted_at', null);
    const lodgeIds = ((lodges ?? []) as { id: string }[]).map((l) => l.id);
    if (lodgeIds.length) {
      const { data: days } = await supabase
        .from('itinerary_days')
        .select('tour_id')
        .in('accommodation_id', lodgeIds)
        .limit(500);
      const tourIds = [...new Set(((days ?? []) as { tour_id: string }[]).map((d) => d.tour_id))].filter((id) => id && !seen.has(id));
      if (tourIds.length) {
        const { data: staying } = await supabase
          .from('tours')
          .select(DESTINATION_TOUR_FIELDS)
          .in('id', tourIds.slice(0, 100))
          .eq('status', 'published')
          .is('deleted_at', null)
          .limit(limit - items.length);
        for (const row of (staying ?? []) as Record<string, unknown>[]) items.push({ ...row, match: 'stays' });
      }
    }
  }

  return sendSuccess(res, 'Destination tours fetched successfully.', { items });
});

