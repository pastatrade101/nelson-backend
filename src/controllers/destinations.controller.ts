import { asyncHandler } from '../utils/async-handler';
import {
  createRecord,
  getRecordBySlug,
  listRecords,
  softDeleteRecord,
  updateRecord
} from '../utils/supabase-helpers';

export const listDestinations = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'destinations',
    // Lean projection for listings: exclude the large `guide` jsonb (and other
    // detail-only fields) so a list of destinations isn't ~50KB/row. The full
    // guide is still returned by the get-by-slug detail endpoint.
    select:
      'id, name, slug, country, region, location, short_description, description, image_url, main_image_url, banner_image_url, latitude, longitude, score_wildlife, score_luxury, score_family, score_photography, score_adventure, score_budget_from, status, is_featured, meta_title, meta_description, og_image_url',
    searchColumns: ['name', 'country', 'region', 'location', 'short_description', 'description'],
    statusColumn: 'status',
    defaultStatus: 'published'
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
