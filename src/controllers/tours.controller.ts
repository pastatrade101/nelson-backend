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
  'id, title, slug, short_description, destination_id, category_id, experience_type, persona_tags, duration_days, duration_nights, budget_tier, price_from, currency, main_image_url, banner_image_url, highlights, difficulty_level, group_size, group_size_min, group_size_max, minimum_age, start_location, end_location, is_available, seats_remaining, status, is_featured, is_popular, seo_title, meta_title, meta_description, og_image_url, destinations(name,slug,country), tour_categories(name,slug)';
// Detail view also embeds the day-by-day itinerary, what's included/excluded,
// the pricing options and the tour gallery images.
const detailSelect = `${select}, itinerary_days(day_number,title,description,accommodation,meals,activities,image_url), tour_inclusions(title,sort_order), tour_exclusions(title,sort_order), tour_price_options(id,tour_id,title,label,price,currency,price_type,description,sort_order,created_at,updated_at), tour_images(id,tour_id,image_url,alt_text,caption,sort_order,is_featured,created_at,updated_at)`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listTours = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'tours',
    select: listSelect,
    searchColumns: ['title', 'short_description', 'full_description'],
    statusColumn: 'status',
    defaultStatus: 'published',
    filters: ['destination_id', 'category_id', 'is_featured', 'is_popular', 'is_available']
  });
});

export const getTour = asyncHandler(async (req, res) => {
  const key = req.params.slug;
  const column = uuidPattern.test(key) ? 'id' : 'slug';
  const { data, error } = await supabase
    .from('tours')
    .select(detailSelect)
    .eq(column, key)
    .is('deleted_at', null)
    .maybeSingle();

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
