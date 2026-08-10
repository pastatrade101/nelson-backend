/**
 * Copy every object from the Supabase Storage bucket to Cloudflare R2, preserving
 * the exact key (folder/uuid.ext) so public URLs stay structurally identical apart
 * from the host. This is the one-time bulk copy behind the "read-time URL rewrite"
 * cutover: after it runs, the frontend rewrites Supabase URLs to the R2 CDN domain
 * and every existing image/thumbnail/variant/video/logo resolves from R2.
 *
 * Safe + idempotent:
 *   - Supabase objects are NOT deleted (they remain a fallback / rollback path).
 *   - Objects already present in R2 are skipped (set FORCE=1 to re-copy all).
 *   - Re-runnable to pick up anything uploaded since the last run.
 *
 * Requires R2 to be configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
 * R2_SECRET_ACCESS_KEY, R2_PUBLIC_BASE_URL). Run:
 *   npm run migrate:r2          (dev / tsx)
 *   npm run migrate:r2:prod     (built / node dist)
 */
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { r2Enabled, r2ObjectExists, r2PutObject } from '../services/r2.service';

const BUCKET = env.SUPABASE_STORAGE_BUCKET;
const PAGE = 1000;

// Immutable content-addressed variants get a year; originals/thumbnails a week.
const cacheFor = (key: string) => (key.includes('/responsive/') ? '31536000' : '604800');

const contentTypeFor = (key: string): string => {
  const ext = key.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    avif: 'image/avif',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    json: 'application/json'
  };
  return (ext && map[ext]) || 'application/octet-stream';
};

// Supabase list() is per-prefix and non-recursive; folder entries come back with
// id === null. Walk the whole tree into a flat list of object keys.
const listAll = async (prefix = ''): Promise<string[]> => {
  const keys: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    const entries = data ?? [];
    for (const entry of entries) {
      if (entry.name === '.emptyFolderPlaceholder') continue;
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) keys.push(...(await listAll(full)));
      else keys.push(full);
    }
    if (entries.length < PAGE) break;
    offset += PAGE;
  }
  return keys;
};

const run = async () => {
  if (!r2Enabled) {
    console.error('R2 is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_PUBLIC_BASE_URL first.');
    process.exit(1);
  }

  const force = process.env.FORCE === '1' || process.env.FORCE === 'true';
  console.log(`Listing objects in Supabase bucket "${BUCKET}"…`);
  const keys = await listAll();
  console.log(`Found ${keys.length} object(s). Copying to R2 bucket "${env.R2_BUCKET}"${force ? ' (FORCE re-copy)' : ''}…`);

  let copied = 0;
  let skipped = 0;
  let failed = 0;

  for (const key of keys) {
    try {
      if (!force && (await r2ObjectExists(key))) {
        skipped += 1;
        continue;
      }
      const { data, error } = await supabase.storage.from(BUCKET).download(key);
      if (error || !data) throw error ?? new Error('empty download');
      const buffer = Buffer.from(await data.arrayBuffer());
      const contentType = data.type && data.type !== 'application/octet-stream' ? data.type : contentTypeFor(key);
      await r2PutObject(key, buffer, contentType, cacheFor(key));
      copied += 1;
      if (copied % 25 === 0) console.log(`  …${copied} copied`);
    } catch (err) {
      failed += 1;
      console.warn(`✗ ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`Done. ${copied} copied, ${skipped} already in R2, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
