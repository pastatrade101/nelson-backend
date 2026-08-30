import { supabase } from '../config/supabase';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';

/**
 * A property's rooms, seasonal rates, highlights and inclusions.
 *
 * Read and written as one document rather than four resources. The admin edits
 * them together — adding a room while reordering rates — so a single atomic
 * replace matches what the editor actually does, and avoids a per-row diff that
 * could half-apply and leave a property describing rooms it no longer has.
 *
 * Ordering is taken from array position, which is what the editor manipulated.
 */

type Row = Record<string, unknown>;

const asArray = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);
const text = (value: unknown): string | null => {
  const s = typeof value === 'string' ? value.trim() : '';
  return s ? s : null;
};
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
/** '' is not a date; Postgres rejects it, and an empty date field is common. */
const date = (value: unknown): string | null => text(value);
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];

export const getLodgeDetails = asyncHandler(async (req, res) => {
  const lodgeId = req.params.id;

  const [highlights, rooms, rates, inclusions] = await Promise.all([
    supabase.from('lodge_highlights').select('*').eq('lodge_id', lodgeId).order('sort_order'),
    supabase
      .from('lodge_rooms')
      .select('*, lodge_room_images(id,image_url,alt_text,caption,sort_order,is_cover)')
      .eq('lodge_id', lodgeId)
      .order('sort_order'),
    supabase.from('lodge_seasonal_rates').select('*').eq('lodge_id', lodgeId).order('sort_order'),
    supabase.from('lodge_inclusions').select('*').eq('lodge_id', lodgeId).order('sort_order')
  ]);

  const failure = [highlights, rooms, rates, inclusions].find((r) => r.error);
  if (failure?.error) throw new AppError('Unable to fetch property details.', 500, [failure.error]);

  return sendSuccess(res, 'Property details fetched successfully.', {
    highlights: highlights.data ?? [],
    rooms: rooms.data ?? [],
    rates: rates.data ?? [],
    inclusions: inclusions.data ?? []
  });
});

export const replaceLodgeDetails = asyncHandler(async (req, res) => {
  const lodgeId = req.params.id;
  const body = req.body as Row;

  // Clear first. lodge_room_images cascade from lodge_rooms, so deleting rooms
  // takes their photographs with them — no separate sweep needed.
  for (const table of ['lodge_highlights', 'lodge_rooms', 'lodge_seasonal_rates', 'lodge_inclusions']) {
    const { error } = await supabase.from(table).delete().eq('lodge_id', lodgeId);
    if (error) throw new AppError('Unable to update property details.', 500, [error]);
  }

  const highlights = asArray(body.highlights)
    .map((h, i) => ({ lodge_id: lodgeId, title: text(h.title) ?? '', sort_order: i }))
    .filter((h) => h.title);
  if (highlights.length) {
    const { error } = await supabase.from('lodge_highlights').insert(highlights);
    if (error) throw new AppError('Unable to save highlights.', 500, [error]);
  }

  const inclusions = asArray(body.inclusions)
    .map((c, i) => ({
      lodge_id: lodgeId,
      title: text(c.title) ?? '',
      is_included: c.is_included !== false,
      sort_order: i
    }))
    .filter((c) => c.title);
  if (inclusions.length) {
    const { error } = await supabase.from('lodge_inclusions').insert(inclusions);
    if (error) throw new AppError('Unable to save inclusions.', 500, [error]);
  }

  const rates = asArray(body.rates)
    .map((r, i) => ({
      lodge_id: lodgeId,
      season_type: text(r.season_type) ?? 'high_season',
      season_name: text(r.season_name),
      valid_from: date(r.valid_from),
      valid_until: date(r.valid_until),
      currency: (text(r.currency) ?? 'USD').toUpperCase().slice(0, 3),
      rack_rate: num(r.rack_rate),
      net_rate: num(r.net_rate),
      single_rate: num(r.single_rate),
      double_rate: num(r.double_rate),
      triple_rate: num(r.triple_rate),
      child_rate: num(r.child_rate),
      single_supplement: num(r.single_supplement),
      pricing_basis: text(r.pricing_basis) ?? 'per_person_sharing',
      meal_plan: text(r.meal_plan) ?? 'full_board',
      notes: text(r.notes),
      sort_order: i
    }))
    // A rate with no figure at all describes nothing.
    .filter((r) => r.rack_rate ?? r.net_rate ?? r.single_rate ?? r.double_rate ?? r.season_name);
  if (rates.length) {
    const { error } = await supabase.from('lodge_seasonal_rates').insert(rates);
    if (error) throw new AppError('Unable to save rates.', 500, [error]);
  }

  // Rooms carry their own images, so they are inserted one at a time to get the
  // new room id back before attaching photographs to it.
  const rooms = asArray(body.rooms).filter((r) => text(r.name));
  for (const [i, room] of rooms.entries()) {
    const { data, error } = await supabase
      .from('lodge_rooms')
      .insert({
        lodge_id: lodgeId,
        name: text(room.name) ?? '',
        room_type: text(room.room_type),
        short_description: text(room.short_description),
        max_adults: num(room.max_adults),
        max_children: num(room.max_children),
        max_guests: num(room.max_guests),
        bed_types: list(room.bed_types),
        unit_count: num(room.unit_count),
        views: list(room.views),
        amenities: list(room.amenities),
        sort_order: i
      })
      .select('id')
      .single();
    if (error) throw new AppError('Unable to save rooms.', 500, [error]);

    const images = asArray(room.images)
      .map((img, n) => ({
        room_id: String(data?.id),
        image_url: text(img.image_url) ?? '',
        alt_text: text(img.alt_text),
        caption: text(img.caption),
        sort_order: n,
        is_cover: n === 0
      }))
      .filter((img) => img.image_url);
    if (images.length) {
      const { error: imageError } = await supabase.from('lodge_room_images').insert(images);
      if (imageError) throw new AppError('Unable to save room images.', 500, [imageError]);
    }
  }

  return getLodgeDetails(req, res, () => undefined);
});
