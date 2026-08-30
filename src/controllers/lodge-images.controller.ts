import { supabase } from '../config/supabase';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getQueryString } from '../utils/query';

/**
 * A property's photo gallery.
 *
 * Kept as an ordered child table rather than columns on `lodges`, because the
 * itinerary day shows a row of four and a lodge realistically has more than two
 * pictures. Mirrors the goldfinch shape so the two codebases stay comparable.
 */
const select = 'id, lodge_id, image_url, alt_text, caption, sort_order, is_cover, created_at, updated_at';

export const listLodgeImages = asyncHandler(async (req, res) => {
  const lodgeId = getQueryString(req.query, 'lodge_id') ?? req.params.lodgeId;

  let query = supabase
    .from('lodge_images')
    .select(select)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (lodgeId && lodgeId !== 'all') query = query.eq('lodge_id', lodgeId);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to fetch lodge images.', 500, [error]);

  return sendSuccess(res, 'Lodge images fetched successfully.', { items: data ?? [] });
});

/**
 * Replace a lodge's whole gallery in one call.
 *
 * The admin edits the gallery as a list — reordering, removing and adding in the
 * same pass — so a single replace is both simpler and atomic from the editor's
 * point of view than a per-image diff. `sort_order` is assigned from array
 * position, which is what the editor actually manipulated.
 */
export const replaceLodgeImages = asyncHandler(async (req, res) => {
  const lodgeId = req.params.lodgeId;
  const body = req.body as { images?: Array<Record<string, unknown>> };
  const incoming = Array.isArray(body?.images) ? body.images : [];

  const rows = incoming
    .map((image, index) => ({
      lodge_id: lodgeId,
      image_url: typeof image.image_url === 'string' ? image.image_url.trim() : '',
      alt_text: typeof image.alt_text === 'string' && image.alt_text.trim() ? image.alt_text.trim() : null,
      caption: typeof image.caption === 'string' && image.caption.trim() ? image.caption.trim() : null,
      sort_order: index,
      is_cover: index === 0
    }))
    .filter((row) => row.image_url);

  const { error: clearError } = await supabase.from('lodge_images').delete().eq('lodge_id', lodgeId);
  if (clearError) throw new AppError('Unable to update lodge images.', 500, [clearError]);

  if (rows.length) {
    const { error: insertError } = await supabase.from('lodge_images').insert(rows);
    if (insertError) throw new AppError('Unable to update lodge images.', 500, [insertError]);
  }

  const { data, error } = await supabase
    .from('lodge_images')
    .select(select)
    .eq('lodge_id', lodgeId)
    .order('sort_order', { ascending: true });
  if (error) throw new AppError('Unable to fetch lodge images.', 500, [error]);

  return sendSuccess(res, 'Lodge images updated successfully.', { items: data ?? [] });
});
