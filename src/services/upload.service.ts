import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { encode as encodeBlurhash } from 'blurhash';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';

// Width of the web-optimized thumbnail we store alongside each uploaded image.
// Big enough for crisp card/grid use on retina, tiny in bytes as webp.
const THUMBNAIL_WIDTH = 600;

// Responsive ladder generated for every image (AVIF + WebP), skipping any width
// larger than the source. Derivatives live at a deterministic path derived from
// the original so the frontend can build a srcset without a per-image lookup:
//   <folder>/<uuid>.<ext>  ->  <folder>/responsive/<uuid>/<width>.{avif,webp}
export const RESPONSIVE_WIDTHS = [320, 480, 640, 768, 960, 1280, 1600, 1920] as const;

// AVIF encoding depends on the sharp build (libheif/libaom). The static format
// flags are unreliable (they can report false even when encoding works), so we
// probe once with a real 2×2 encode; when unavailable we still generate WebP.
let avifSupported: boolean | null = null;
const supportsAvif = async (): Promise<boolean> => {
  if (avifSupported === null) {
    try {
      await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 0, g: 0, b: 0 } } }).avif({ effort: 0 }).toBuffer();
      avifSupported = true;
    } catch {
      avifSupported = false;
    }
  }
  return avifSupported;
};

export type ImageMeta = {
  width?: number;
  height?: number;
  aspectRatio?: number;
  blurhash?: string;
  dominantColor?: string;
};

// Cheap, synchronous-ish metadata for CLS-free rendering + placeholders. Each
// piece is best-effort so a decode quirk never blocks an upload.
export const extractImageMeta = async (buffer: Buffer): Promise<ImageMeta> => {
  const meta: ImageMeta = {};
  try {
    const m = await sharp(buffer).metadata();
    let w = m.width;
    let h = m.height;
    // EXIF orientations 5-8 rotate 90/270°, swapping the effective dimensions.
    if (m.orientation && m.orientation >= 5 && w && h) [w, h] = [h, w];
    if (w && h) {
      meta.width = w;
      meta.height = h;
      meta.aspectRatio = Math.round((w / h) * 10000) / 10000;
    }
  } catch {
    /* ignore */
  }
  try {
    const { data, info } = await sharp(buffer).rotate().resize(32, 32, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    meta.blurhash = encodeBlurhash(new Uint8ClampedArray(data), info.width, info.height, 4, 3);
  } catch {
    /* ignore */
  }
  try {
    const { dominant } = await sharp(buffer).stats();
    meta.dominantColor = `#${[dominant.r, dominant.g, dominant.b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    /* ignore */
  }
  return meta;
};

let bucketReadyPromise: Promise<void> | null = null;

const extensionFromMime = (mimeType: string) => {
  const map: Record<string, string> = {
    'application/json': 'json',
    'application/octet-stream': 'json',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'text/json': 'json',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov'
  };

  return map[mimeType];
};

export const ensureStorageBucket = async () => {
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      const { error: getError } = await supabase.storage.getBucket(env.SUPABASE_STORAGE_BUCKET);
      if (!getError) return;

      const { error: createError } = await supabase.storage.createBucket(env.SUPABASE_STORAGE_BUCKET, {
        public: true
      });

      if (createError) {
        const message = `${getError.message} ${createError.message}`.toLowerCase();
        if (message.includes('already exists') || message.includes('duplicate')) return;

        throw new AppError('Supabase Storage bucket is not available.', 500, [createError]);
      }
    })();
  }

  try {
    await bucketReadyPromise;
  } catch (error) {
    bucketReadyPromise = null;
    throw error;
  }
};

// Upload a raw buffer to storage and return its public URL.
const putObject = async (path: string, buffer: Buffer, contentType: string) => {
  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(path, buffer, {
    contentType,
    cacheControl: '3600',
    upsert: false
  });

  if (error) throw new AppError(`Unable to upload file to Supabase Storage: ${error.message}`, 500, [error]);

  const { data } = supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
};

// Variant objects are content-addressed (uuid + width + format) and never change,
// so they get an immutable 1-year cache and upsert (safe to re-run backfills).
const putVariant = async (path: string, buffer: Buffer, contentType: string) => {
  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(path, buffer, {
    contentType,
    cacheControl: '31536000',
    upsert: true
  });
  if (error) throw new AppError(`Unable to upload variant: ${error.message}`, 500, [error]);
};

const uploadToStorage = async (file: Express.Multer.File, folder: string, allowedMimeTypes: string[], errorMessage: string) => {
  const extension = extensionFromMime(file.mimetype);
  if (!extension || !allowedMimeTypes.includes(file.mimetype)) throw new AppError(errorMessage, 400);

  await ensureStorageBucket();

  const path = `${folder}/${randomUUID()}.${extension}`;
  const url = await putObject(path, file.buffer, file.mimetype);

  return {
    path,
    url,
    mimeType: file.mimetype,
    size: file.size
  };
};

export const uploadImageToStorage = async (file: Express.Multer.File, folder = 'uploads') => {
  const result = await uploadToStorage(file, folder, ['image/jpeg', 'image/png', 'image/webp'], 'Only jpg, jpeg, png, and webp images are allowed.');

  // Generate a small webp thumbnail. This is a pure optimization — if it fails
  // for any reason, the upload still succeeds and we fall back to the original.
  let thumbnailPath: string | undefined;
  let thumbnailUrl: string | undefined;
  try {
    const thumbnailBuffer = await sharp(file.buffer)
      .rotate() // honour EXIF orientation
      .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
    thumbnailPath = `${folder}/thumbnails/${randomUUID()}.webp`;
    thumbnailUrl = await putObject(thumbnailPath, thumbnailBuffer, 'image/webp');
  } catch {
    thumbnailPath = undefined;
    thumbnailUrl = undefined;
  }

  const meta = await extractImageMeta(file.buffer).catch(() => ({} as ImageMeta));

  return { ...result, thumbnailPath, thumbnailUrl, ...meta };
};

// Generate the full responsive ladder (AVIF + WebP) for an image and record which
// widths succeeded on its media row. Runs in the background after the upload has
// already responded — AVIF encoding is CPU-heavy, so doing it inline would make
// uploads slow/time out. Every step is best-effort.
export const generateResponsiveVariants = async (
  mediaId: string,
  buffer: Buffer,
  folder: string,
  originalPath: string
): Promise<void> => {
  try {
    await ensureStorageBucket();
    // Deterministic stem from "<folder>/<uuid>.<ext>" so the frontend can build
    // variant URLs straight from the original URL.
    const stem = (originalPath.split('/').pop() ?? randomUUID()).replace(/\.[^.]+$/, '');
    const base = `${folder}/responsive/${stem}`;

    let sourceWidth = 0;
    try {
      sourceWidth = (await sharp(buffer).metadata()).width ?? 0;
    } catch {
      /* ignore */
    }

    const widths = RESPONSIVE_WIDTHS.filter((w) => sourceWidth === 0 || w <= sourceWidth);
    if (!widths.length && sourceWidth) widths.push(sourceWidth as never);

    const avif = await supportsAvif();
    const done: number[] = [];

    for (const width of widths) {
      try {
        const resized = sharp(buffer).rotate().resize({ width, withoutEnlargement: true });
        const webp = await resized.clone().webp({ quality: 72 }).toBuffer();
        await putVariant(`${base}/${width}.webp`, webp, 'image/webp');
        if (avif) {
          try {
            const av = await resized.clone().avif({ quality: 50, effort: 4 }).toBuffer();
            await putVariant(`${base}/${width}.avif`, av, 'image/avif');
          } catch {
            /* AVIF unavailable for this image — WebP still covers it */
          }
        }
        done.push(width);
      } catch {
        /* per-width best-effort */
      }
    }

    if (done.length) {
      await supabase
        .from('media_library')
        .update({ variant_widths: done, has_avif: avif })
        .eq('id', mediaId)
        .then(
          () => undefined,
          () => undefined
        );
    }
  } catch {
    /* whole-image best-effort — never throw from a background job */
  }
};

// Upload a video (mp4/webm/mov). No thumbnail is generated (sharp can't decode
// video); the media record just references the file itself.
export const uploadVideoToStorage = async (file: Express.Multer.File, folder = 'videos') => {
  return uploadToStorage(file, folder, ['video/mp4', 'video/webm', 'video/quicktime'], 'Only mp4, webm, or mov videos are allowed.');
};

export const uploadLottieToStorage = async (file: Express.Multer.File, folder = 'lottie') => {
  if (!file.originalname.toLowerCase().endsWith('.json')) {
    throw new AppError('Only Lottie JSON files are allowed.', 400);
  }

  try {
    JSON.parse(file.buffer.toString('utf-8'));
  } catch {
    throw new AppError('Lottie file must be valid JSON.', 400);
  }

  return uploadToStorage(file, folder, ['application/json', 'application/octet-stream', 'text/json'], 'Only Lottie JSON files are allowed.');
};

export const deleteImageFromStorage = async (path: string) => {
  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).remove([path]);
  if (error) throw new AppError('Unable to delete image.', 500, [error]);
};
