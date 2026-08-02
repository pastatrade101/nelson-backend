/**
 * Backfill the responsive AVIF/WebP ladder + image metadata for images uploaded
 * before the responsive pipeline. For every image in media_library that has no
 * variants yet, it downloads the original, extracts metadata (dimensions,
 * aspect ratio, blurhash, dominant colour), generates the responsive ladder, and
 * saves everything back to the row.
 *
 * Safe to re-run: variant objects upsert, and only rows missing variants are
 * processed. Run once after applying 2026-08-02-responsive-images.sql:
 *   npm run backfill:responsive          (dev / tsx)
 *   npm run backfill:responsive:prod     (built / node dist)
 *
 * Optional: LIMIT=100 npm run backfill:responsive   (process in batches)
 */
import { supabase } from '../config/supabase';
import { ensureStorageBucket, extractImageMeta, generateResponsiveVariants, type ImageMeta } from '../services/upload.service';

const run = async () => {
  await ensureStorageBucket();

  const limit = Number(process.env.LIMIT) || 10000;

  const { data, error } = await supabase
    .from('media_library')
    .select('id, file_url, file_path, width, variant_widths')
    .eq('file_type', 'image')
    .is('deleted_at', null)
    .or('variant_widths.is.null,variant_widths.eq.{}')
    .limit(limit);

  if (error) throw error;

  const rows = data ?? [];
  console.log(`Found ${rows.length} image(s) needing responsive variants.`);

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const response = await fetch(row.file_url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const original = Buffer.from(await response.arrayBuffer());

      // Refresh metadata (only fills gaps; harmless if already set).
      const meta: ImageMeta = await extractImageMeta(original).catch(() => ({}));
      if (Object.keys(meta).length) {
        await supabase
          .from('media_library')
          .update({
            width: meta.width ?? null,
            height: meta.height ?? null,
            aspect_ratio: meta.aspectRatio ?? null,
            blurhash: meta.blurhash ?? null,
            dominant_color: meta.dominantColor ?? null
          })
          .eq('id', row.id);
      }

      const folder = row.file_path?.includes('/') ? row.file_path.split('/').slice(0, -1).join('/') : 'uploads';
      await generateResponsiveVariants(row.id, original, folder, row.file_path);

      ok += 1;
      console.log(`✓ ${row.id}`);
    } catch (err) {
      failed += 1;
      console.warn(`✗ ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Done. ${ok} succeeded, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
