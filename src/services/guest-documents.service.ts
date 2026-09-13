import { randomBytes } from 'crypto';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';

/**
 * Storage for passport copies.
 *
 * DELIBERATELY SEPARATE FROM upload.service.ts. That path writes to a PUBLIC
 * bucket and registers the file in media_library, where anything with the URL
 * is world-readable and an editor could pick it as a hero image. A passport
 * scan must never touch it.
 *
 * Everything here goes to a private bucket instead:
 *   - the bucket is created with `public: false`, so there is no public URL;
 *   - nothing is registered in media_library;
 *   - the object key is unguessable, and is all that is stored on the guest row;
 *   - the office reads a file through a signed URL that expires in minutes,
 *     minted only for an authenticated admin holding guest_details.view.
 */

export const GUEST_DOCS_BUCKET = 'guest-documents';

/** Short: long enough to click through to, short enough to be useless if shared. */
const SIGNED_URL_TTL_SECONDS = 120;

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * A passport page is a photo or a scan. Nothing executable, nothing that a
 * browser would render as markup if it were ever served inline.
 */
const ALLOWED = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/heic', 'heic'],
  ['application/pdf', 'pdf']
]);

let bucketReady: Promise<void> | null = null;

/** Create the private bucket on first use. Idempotent. */
const ensureBucket = async (): Promise<void> => {
  if (!bucketReady) {
    bucketReady = (async () => {
      const { error: getError } = await supabase.storage.getBucket(GUEST_DOCS_BUCKET);
      if (!getError) return;
      const { error: createError } = await supabase.storage.createBucket(GUEST_DOCS_BUCKET, {
        public: false,
        fileSizeLimit: MAX_BYTES,
        allowedMimeTypes: [...ALLOWED.keys()]
      });
      // Another request may have created it in the meantime.
      if (createError && !/already exists/i.test(createError.message)) {
        bucketReady = null;
        throw new AppError('Secure document storage is unavailable.', 500, [createError]);
      }
    })();
  }
  try {
    await bucketReady;
  } catch (error) {
    bucketReady = null;
    throw error;
  }
};

export type StoredDocument = { path: string; size: number; contentType: string };

/**
 * Store one passport copy and return its object key.
 *
 * The key embeds the submission id so an orphaned file can be traced, and a
 * random component so it cannot be guessed from the submission id alone.
 */
export const storeGuestDocument = async (
  submissionId: string,
  file: { buffer: Buffer; mimetype: string; size: number }
): Promise<StoredDocument> => {
  const extension = ALLOWED.get(file.mimetype);
  if (!extension) {
    throw new AppError('Please upload a JPG, PNG, HEIC or PDF of the passport page.', 400);
  }
  if (file.size > MAX_BYTES) {
    throw new AppError('That file is larger than 8MB. Please upload a smaller photo or scan.', 400);
  }

  await ensureBucket();

  const path = `${submissionId}/${randomBytes(16).toString('hex')}.${extension}`;
  const { error } = await supabase.storage
    .from(GUEST_DOCS_BUCKET)
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
  if (error) throw new AppError('Unable to store the passport copy.', 500, [error]);

  return { path, size: file.size, contentType: file.mimetype };
};

/**
 * Mint a short-lived URL for the office to open one document.
 *
 * Called only from an authenticated admin route. The URL is never persisted and
 * never returned to a guest.
 */
export const signGuestDocument = async (path: string): Promise<string> => {
  const { data, error } = await supabase.storage
    .from(GUEST_DOCS_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw new AppError('Unable to open that document.', 404, error ? [error] : []);
  }
  return data.signedUrl;
};

/** Remove a document, e.g. when a traveller is deleted from a submission. */
export const deleteGuestDocument = async (path: string): Promise<void> => {
  if (!path) return;
  await supabase.storage.from(GUEST_DOCS_BUCKET).remove([path]);
};
