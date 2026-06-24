import { randomUUID } from 'crypto';
import sharp from 'sharp';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';

// Width of the web-optimized thumbnail we store alongside each uploaded image.
// Big enough for crisp card/grid use on retina, tiny in bytes as webp.
const THUMBNAIL_WIDTH = 600;

let bucketReadyPromise: Promise<void> | null = null;

const extensionFromMime = (mimeType: string) => {
  const map: Record<string, string> = {
    'application/json': 'json',
    'application/octet-stream': 'json',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'text/json': 'json',
    'image/webp': 'webp'
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

  return { ...result, thumbnailPath, thumbnailUrl };
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
