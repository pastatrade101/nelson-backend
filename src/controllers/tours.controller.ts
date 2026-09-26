import { asyncHandler } from '../utils/async-handler';
import { supabase } from '../config/supabase';
import { AppError, sendSuccess } from '../utils/api-response';
import {
  createRecord,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

const select = '*, destinations(name,slug,country), tour_categories(name,slug)';
// Lean projection for listings: everything the cards use, minus the detail-only
// heavy fields (full_description, sample_itinerary). getTour still uses the full
// select + embeds below.
const listSelect =
  'id, title, slug, short_description, destination_id, countries, category_id, experience_type, persona_tags, duration_days, duration_nights, budget_tier, price_from, currency, main_image_url, banner_image_url, highlights, difficulty_level, group_size, group_size_min, group_size_max, minimum_age, start_location, end_location, is_available, seats_remaining, status, is_featured, is_popular, seo_title, meta_title, meta_description, og_image_url, updated_at, destinations(name,slug,country), tour_categories(name,slug)';
// Detail view also embeds the day-by-day itinerary, what's included/excluded,
// the pricing options and the tour gallery images.
const TOUR_DETAIL_TAIL =
  ', tour_inclusions(title,sort_order), tour_exclusions(title,sort_order), tour_price_options(id,tour_id,title,label,price,currency,price_type,description,sort_order,created_at,updated_at), tour_images(id,tour_id,image_url,alt_text,caption,sort_order,is_featured,created_at,updated_at)';

const ITINERARY_FIELDS = 'day_number,title,description,accommodation,meals,activities,image_url';

// The linked property and its gallery. Requires the 2026-08-27 migration.
const ITINERARY_LODGE =
  ',accommodation_id,lodge:lodges!itinerary_days_accommodation_id_fkey(id,name,slug,lodge_type,accommodation_level,hero_image_url,image_url,lodge_images(id,image_url,alt_text,caption,sort_order,is_cover),destinations(name))';

// Catalogue activities linked to the day, through the join table. Requires the
// 2026-09-26 migration; folded into the same fallback as the property embed so
// one pending migration cannot take every tour page down.
const ITINERARY_ACTIVITIES =
  ',day_activities:itinerary_day_activities(sort_order,activity:activities(id,name,slug,category,duration_label,price_from,currency,price_unit,badge,hero_image_url,image_url,status))';

const detailSelect = `${select}, itinerary_days(${ITINERARY_FIELDS}${ITINERARY_LODGE}${ITINERARY_ACTIVITIES})${TOUR_DETAIL_TAIL}`;

// The same view WITHOUT the property embed, for a database that has not had the
// migration applied. PostgREST rejects the whole query when it cannot resolve an
// embed, so without this a pending migration would take every tour page down
// rather than merely hiding the gallery. Built explicitly rather than by
// stripping the string, so it cannot silently drift.
const detailSelectLegacy = `${select}, itinerary_days(${ITINERARY_FIELDS})${TOUR_DETAIL_TAIL}`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listTours = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'tours',
    select: listSelect,
    searchColumns: ['title', 'short_description', 'full_description'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['destination_id', 'category_id', 'is_featured', 'is_popular', 'is_available'],
    // ?country=Kenya matches a trip whose countries include Kenya, so a
    // multi-country journey shows up under each country it visits.
    arrayFilters: [
      { param: 'country', column: 'countries' },
      // ?persona=couple matches a trip tagged for couples. Multi-value, because a
      // trip can genuinely suit couples and families both.
      { param: 'persona', column: 'persona_tags' }
    ]
  });
});

export const getTour = asyncHandler(async (req, res) => {
  const key = req.params.slug;
  const column = uuidPattern.test(key) ? 'id' : 'slug';
  const fetchWith = (select: string) =>
    supabase.from('tours').select(select).eq(column, key).is('deleted_at', null).maybeSingle();

  let { data, error } = await fetchWith(detailSelect);

  // PGRST200 = an embed could not be resolved, which here means the lodge link
  // migration has not been applied yet. Serve the tour without the property
  // gallery rather than failing the page.
  if (error && (error as { code?: string }).code === 'PGRST200') {
    ({ data, error } = await fetchWith(detailSelectLegacy));
  }

  if (error) throw new AppError('Unable to fetch tours.', 500, [error]);
  if (!data) throw new AppError('Record not found.', 404);

  return sendSuccess(res, 'Record fetched successfully.', data);
});

export const createTour = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'tours', req.body, { slugSource: 'title', userFields: true });
});

export const updateTour = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'tours', req.params.id, req.body, { slugSource: 'title', userFields: true });
});

export const deleteTour = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'tours', req.params.id, req);
});
