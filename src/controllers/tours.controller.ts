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
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const listTours = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'tours',
    select,
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
    .select(select)
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
