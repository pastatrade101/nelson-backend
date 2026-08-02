import { asyncHandler } from '../utils/async-handler';
import { createRecord, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';
import { supabase } from '../config/supabase';
import { sendSuccess } from '../utils/api-response';

// Public, unauthenticated resolver: given a batch of image URLs, return their
// responsive-variant metadata (which widths exist, AVIF availability, intrinsic
// dimensions, blurhash, dominant colour) so the frontend can build an exact
// AVIF/WebP srcset without a per-entity schema change. Unknown/external URLs are
// simply omitted, and the frontend falls back to the original.
export const resolveImageVariants = asyncHandler(async (req, res) => {
  const raw = typeof req.query.urls === 'string' ? req.query.urls : '';
  const urls = [...new Set(raw.split(',').map((u) => u.trim()).filter(Boolean))].slice(0, 100);
  if (!urls.length) return sendSuccess(res, 'No urls provided.', {});

  const { data, error } = await supabase
    .from('media_library')
    .select('file_url, width, height, aspect_ratio, blurhash, dominant_color, variant_widths, has_avif')
    .in('file_url', urls)
    .is('deleted_at', null);

  // Best-effort: never fail the page over image metadata (e.g. before the
  // migration adds the columns) — return empty and let the frontend fall back.
  if (error) return sendSuccess(res, 'Image variants unavailable.', {});

  const map: Record<string, unknown> = {};
  for (const row of data ?? []) {
    map[row.file_url] = {
      width: row.width,
      height: row.height,
      aspectRatio: row.aspect_ratio,
      blurhash: row.blurhash,
      dominantColor: row.dominant_color,
      widths: row.variant_widths ?? [],
      hasAvif: row.has_avif
    };
  }
  return sendSuccess(res, 'Resolved image variants.', map);
});

export const listMedia = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'media_library',
    searchColumns: ['file_name', 'alt_text', 'caption', 'mime_type'],
    filters: ['file_type', 'uploaded_by']
  });
});

export const createMedia = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'media_library', {
    ...req.body,
    uploaded_by: req.user?.sub ?? null
  });
});

export const updateMedia = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'media_library', req.params.id, req.body);
});

export const deleteMedia = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'media_library', req.params.id, req);
});
