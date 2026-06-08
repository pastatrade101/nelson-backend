import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { cleanSearch, getQueryString } from '../utils/query';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// `tours!inner` makes the join an inner join so only departures attached to a
// published, available, non-deleted tour are returned. destinations/categories
// stay optional embeds so departures without them still appear.
const select =
  'id, tour_id, start_date, end_date, available_slots, price, price_override, currency, status, notes, ' +
  'tours!inner ( id, title, slug, status, is_available, deleted_at, duration_days, main_image_url, price_from, currency, ' +
  'destinations ( name, slug ), tour_categories ( name, slug ) )';

const resolveId = async (table: 'destinations' | 'tour_categories', value: string) => {
  if (uuidPattern.test(value)) return value;
  const { data } = await supabase.from(table).select('id').eq('slug', value).maybeSingle();
  return (data as { id?: string } | null)?.id ?? null;
};

const relation = (value: unknown) => {
  if (Array.isArray(value)) return (value[0] ?? {}) as Record<string, unknown>;
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return {};
};

export const listPublicDepartures = asyncHandler(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);

  const search = cleanSearch(getQueryString(req.query, 'search'));
  const destination = getQueryString(req.query, 'destination');
  const category = getQueryString(req.query, 'category');
  const month = getQueryString(req.query, 'month');
  const statusFilter = getQueryString(req.query, 'status');
  const minPrice = getQueryString(req.query, 'min_price');
  const maxPrice = getQueryString(req.query, 'max_price');
  const sort = getQueryString(req.query, 'sort');
  const limit = Math.min(Math.max(Number(getQueryString(req.query, 'limit')) || 100, 1), 200);

  let query = supabase
    .from('available_dates')
    .select(select)
    .eq('tours.status', 'published')
    .eq('tours.is_available', true)
    .is('tours.deleted_at', null)
    .in('status', ['available', 'limited'])
    .gte('start_date', today);

  // Narrow to a single public status if requested.
  if (statusFilter === 'available' || statusFilter === 'limited') query = query.eq('status', statusFilter);

  if (destination && destination !== 'all') {
    const destinationId = await resolveId('destinations', destination);
    if (!destinationId) return sendSuccess(res, 'Departures fetched successfully.', []);
    query = query.eq('tours.destination_id', destinationId);
  }

  if (category && category !== 'all') {
    const categoryId = await resolveId('tour_categories', category);
    if (!categoryId) return sendSuccess(res, 'Departures fetched successfully.', []);
    query = query.eq('tours.category_id', categoryId);
  }

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [year, monthNumber] = month.split('-').map(Number);
    const firstDay = `${month}-01`;
    const nextMonth = monthNumber === 12 ? `${year + 1}-01-01` : `${year}-${String(monthNumber + 1).padStart(2, '0')}-01`;
    query = query.gte('start_date', firstDay).lt('start_date', nextMonth);
  }

  if (minPrice) query = query.gte('price', Number(minPrice));
  if (maxPrice) query = query.lte('price', Number(maxPrice));
  if (search) query = query.ilike('tours.title', `%${search}%`);

  if (sort === 'price') query = query.order('price', { ascending: true, nullsFirst: false });
  query = query.order('start_date', { ascending: true });

  const { data, error } = await query.limit(limit);
  if (error) throw new AppError('Unable to fetch departures.', 500, [error]);

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  const departures = rows.map((record) => {
    const tour = relation(record.tours);
    const dest = relation(tour.destinations);
    const cat = relation(tour.tour_categories);

    return {
      id: record.id,
      tour_id: record.tour_id,
      tour_title: tour.title ?? '',
      tour_slug: tour.slug ?? '',
      destination_name: dest.name ?? '',
      destination_slug: dest.slug ?? '',
      category_name: cat.name ?? '',
      category_slug: cat.slug ?? '',
      start_date: record.start_date,
      end_date: record.end_date ?? null,
      duration_days: tour.duration_days ?? null,
      available_slots: record.available_slots ?? null,
      price: record.price ?? record.price_override ?? tour.price_from ?? null,
      currency: record.currency ?? tour.currency ?? 'USD',
      status: record.status,
      notes: record.notes ?? null,
      main_image_url: tour.main_image_url ?? null
    };
  });

  return sendSuccess(res, 'Departures fetched successfully.', departures);
});
