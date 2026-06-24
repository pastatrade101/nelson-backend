/**
 * Backfill thumbnails for images uploaded before server-side thumbnailing.
 * For every image in media_library without a thumbnail_url, it downloads the
 * original, generates a webp thumbnail, uploads it, and saves thumbnail_url.
 *
 * Run once after applying 2026-06-24-media-thumbnails.sql:
 *   npm run backfill:thumbnails          (dev / tsx)
 *   npm run backfill:thumbnails:prod     (built / node dist)
 */
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { ensureStorageBucket } from '../services/upload.service';

const THUMBNAIL_WIDTH = 600;

const run = async () => {
  // Create the storage bucket if it doesn't exist yet (e.g. when no real file
  // has been uploaded through the admin so far), matching the upload flow.
  await ensureStorageBucket();

  const { data, error } = await supabase
    .from('media_library')
    .select('id, file_url, file_path')
    .eq('file_type', 'image')
    .is('thumbnail_url', null)
    .is('deleted_at', null);

  if (error) throw error;

  const rows = data ?? [];
  console.log(`Found ${rows.length} image(s) needing a thumbnail.`);

  let ok = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const response = await fetch(row.file_url);
      if (!response.ok) throw new Error(`download failed (${response.status})`);
      const original = Buffer.from(await response.arrayBuffer());

      const thumbnail = await sharp(original)
        .rotate()
        .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();

      const folder = row.file_path?.includes('/') ? row.file_path.split('/').slice(0, -1).join('/') : 'uploads';
      const thumbnailPath = `${folder}/thumbnails/${randomUUID()}.webp`;

      const upload = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(thumbnailPath, thumbnail, {
        contentType: 'image/webp',
        cacheControl: '3600',
        upsert: false
      });
      if (upload.error) throw upload.error;

      const { data: pub } = supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(thumbnailPath);

      const update = await supabase
        .from('media_library')
        .update({ thumbnail_url: pub.publicUrl, thumbnail_path: thumbnailPath })
        .eq('id', row.id);
      if (update.error) throw update.error;

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
