import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';

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

const ensureStorageBucket = async () => {
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

const uploadToStorage = async (file: Express.Multer.File, folder: string, allowedMimeTypes: string[], errorMessage: string) => {
  const extension = extensionFromMime(file.mimetype);
  if (!extension || !allowedMimeTypes.includes(file.mimetype)) throw new AppError(errorMessage, 400);

  await ensureStorageBucket();

  const path = `${folder}/${randomUUID()}.${extension}`;

  const { error } = await supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(path, file.buffer, {
    contentType: file.mimetype,
    cacheControl: '3600',
    upsert: false
  });

  if (error) throw new AppError(`Unable to upload file to Supabase Storage: ${error.message}`, 500, [error]);

  const { data } = supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(path);

  return {
    path,
    url: data.publicUrl,
    mimeType: file.mimetype,
    size: file.size
  };
};

export const uploadImageToStorage = async (file: Express.Multer.File, folder = 'uploads') => {
  return uploadToStorage(file, folder, ['image/jpeg', 'image/png', 'image/webp'], 'Only jpg, jpeg, png, and webp images are allowed.');
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
