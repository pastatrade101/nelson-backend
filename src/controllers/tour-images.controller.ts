import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { AppError, sendSuccess } from '../utils/api-response';
import { asyncHandler } from '../utils/async-handler';
import { getPagination, getQueryString, paginationMeta } from '../utils/query';

const select = '*, tours(id,title,slug,status)';

export const listTourImages = asyncHandler(async (req, res) => {
  const { page, limit, from, to } = getPagination(req.query);
  const tourId = getQueryString(req.query, 'tour_id');

  let query = supabase
    .from('tour_images')
    .select(select, { count: 'exact' })
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (tourId && tourId !== 'all') query = query.eq('tour_id', tourId);

  const { data, error, count } = await query.range(from, to);
  if (error) throw new AppError('Unable to fetch tour images.', 500, [error]);

  return sendSuccess(res, 'Tour images fetched successfully.', {
    items: data ?? [],
    pagination: paginationMeta(page, limit, count ?? 0)
  });
});

export const listTourImagesForTour = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_images')
    .select(select)
    .eq('tour_id', req.params.tourId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new AppError('Unable to fetch tour images.', 500, [error]);

  return sendSuccess(res, 'Tour images fetched successfully.', data ?? []);
});

export const getTourImage = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_images')
    .select(select)
    .eq('id', req.params.id)
    .maybeSingle();

  if (error) throw new AppError('Unable to fetch tour image.', 500, [error]);
  if (!data) throw new AppError('Tour image not found.', 404);

  return sendSuccess(res, 'Tour image fetched successfully.', data);
});

export const createTourImage = asyncHandler(async (req, res) => {
  const payload = req.body as Record<string, unknown>;

  if (payload.is_featured) {
    await supabase
      .from('tour_images')
      .update({ is_featured: false })
      .eq('tour_id', String(payload.tour_id))
      .eq('is_featured', true);
  }

  const { data, error } = await supabase
    .from('tour_images')
    .insert(payload)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to create tour image.', 500, [error]);

  await safeAudit({ action: 'create', entityId: data?.id, entityType: 'tour_images', newData: data, req });

  return sendSuccess(res, 'Tour image created successfully.', data, 201);
});

export const updateTourImage = asyncHandler(async (req, res) => {
  const { data: previous, error: prevError } = await supabase
    .from('tour_images')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (prevError) throw new AppError('Unable to fetch tour image.', 500, [prevError]);
  if (!previous) throw new AppError('Tour image not found.', 404);

  const payload = req.body as Record<string, unknown>;

  if (payload.is_featured) {
    const tourId = String(payload.tour_id ?? previous.tour_id);
    await supabase
      .from('tour_images')
      .update({ is_featured: false })
      .eq('tour_id', tourId)
      .eq('is_featured', true)
      .neq('id', req.params.id);
  }

  const { data, error } = await supabase
    .from('tour_images')
    .update(payload)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update tour image.', 500, [error]);

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'tour_images', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Tour image updated successfully.', data);
});

export const deleteTourImage = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase
    .from('tour_images')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  const { error } = await supabase.from('tour_images').delete().eq('id', req.params.id);
  if (error) throw new AppError('Unable to delete tour image.', 500, [error]);

  await safeAudit({ action: 'delete', entityId: req.params.id, entityType: 'tour_images', oldData: previous, req });

  return sendSuccess(res, 'Tour image deleted successfully.');
});
