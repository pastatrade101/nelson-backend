/**
 * Backfill: down-cap oversized ORIGINAL images already in storage.
 *
 * The site was storing full-size originals (multi-MB phone photos) and serving
 * them straight from Supabase Storage, blowing the free-tier egress quota. This
 * re-encodes every media_library image wider than MAX_ORIGINAL_WIDTH to a capped
 * webp and re-uploads it IN PLACE — the object key (and therefore the public URL)
 * never changes, so every denormalized copy of that URL across
 * tours/destinations/lodges/etc. instantly serves the smaller bytes with no table
 * rewrites and no broken links. Browsers honour the Content-Type header, so a
 * .jpg/.png key serving webp bytes renders correctly.
 *
 * Existing responsive variants + thumbnails are keyed off the same (unchanged)
 * path, so they stay valid — nothing to regenerate.
 *
 * Run AFTER deploying the upload-time down-cap. Idempotent: a second run skips
 * anything already <= MAX_ORIGINAL_WIDTH, so it is safe to re-run and to batch
 * with LIMIT=<n>:
 *   npm run backfill:downcap          (dev / tsx)
 *   npm run backfill:downcap:prod     (built / node dist)
 */
import sharp from 'sharp';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { ensureStorageBucket, extractImageMeta } from '../services/upload.service';

// Keep in lockstep with MAX_ORIGINAL_WIDTH in upload.service.ts.
const MAX_ORIGINAL_WIDTH = 2560;
const ONE_WEEK = '604800';

const kb = (bytes: number) => `${Math.round(bytes / 1024)}KB`;

const run = async () => {
  await ensureStorageBucket();
  const limit = Number(process.env.LIMIT) || 100000;

  const { data, error } = await supabase
    .from('media_library')
    .select('id, file_url, file_path')
    .eq('file_type', 'image')
    .is('deleted_at', null)
    .limit(limit);
  if (error) throw error;

  const rows = data ?? [];
  console.log(`Scanning ${rows.length} image(s) for oversized originals (> ${MAX_ORIGINAL_WIDTH}px).`);

  let capped = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      if (!row.file_path || !row.file_url) {
        skipped += 1;
        continue;
      }

      const response = await fetch(row.file_url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const original = Buffer.from(await response.arrayBuffer());

      const meta = await sharp(original, { failOn: 'none' }).metadata();
      // Orientations 5-8 rotate 90/270°, so the post-rotate width is the height.
      const effectiveWidth = meta.orientation && meta.orientation >= 5 ? meta.height ?? 0 : meta.width ?? 0;
      if (!effectiveWidth || effectiveWidth <= MAX_ORIGINAL_WIDTH) {
        skipped += 1;
        continue;
      }

      const out = await sharp(original, { failOn: 'none' })
        .rotate()
        .resize({ width: MAX_ORIGINAL_WIDTH, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

      // Re-upload IN PLACE (same key) so the public URL never changes. upsert:true
      // overwrites the existing object; the new bytes are webp under the original
      // .jpg/.png key, and the Content-Type header tells browsers what they are.
      const upload = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(row.file_path, out, {
        contentType: 'image/webp',
        cacheControl: ONE_WEEK,
        upsert: true
      });
      if (upload.error) throw upload.error;

      // Keep DB metadata truthful about the bytes now stored (URL/path unchanged).
      const dims = await extractImageMeta(out).catch(() => ({} as { width?: number; height?: number; aspectRatio?: number }));
      const update = await supabase
        .from('media_library')
        .update({
          mime_type: 'image/webp',
          file_size: out.length,
          width: dims.width ?? null,
          height: dims.height ?? null,
          aspect_ratio: dims.aspectRatio ?? null
        })
        .eq('id', row.id);
      if (update.error) throw update.error;

      capped += 1;
      console.log(`✓ ${row.id} (${effectiveWidth}px, ${kb(original.length)} → ${MAX_ORIGINAL_WIDTH}px, ${kb(out.length)})`);
    } catch (err) {
      failed += 1;
      console.warn(`✗ ${row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Done. ${capped} down-capped, ${skipped} already small/skipped, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
