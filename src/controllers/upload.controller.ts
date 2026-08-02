import { deleteImageFromStorage, generateResponsiveVariants, uploadImageToStorage, uploadLottieToStorage, uploadVideoToStorage } from '../services/upload.service';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';

export const uploadImage = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Image file is required.', 400);

  const folder = typeof req.body.folder === 'string' ? req.body.folder : 'uploads';
  const result = await uploadImageToStorage(req.file, folder);

  const { data: media, error: mediaError } = await supabase.from('media_library').insert({
    alt_text: req.body.alt_text ?? null,
    caption: req.body.caption ?? null,
    file_name: req.file.originalname,
    file_path: result.path,
    file_size: result.size,
    file_type: 'image',
    file_url: result.url,
    thumbnail_path: result.thumbnailPath ?? null,
    thumbnail_url: result.thumbnailUrl ?? null,
    mime_type: result.mimeType,
    width: result.width ?? null,
    height: result.height ?? null,
    aspect_ratio: result.aspectRatio ?? null,
    blurhash: result.blurhash ?? null,
    dominant_color: result.dominantColor ?? null,
    uploaded_by: req.user?.sub ?? null
  }).select('*').single();

  if (mediaError) {
    await deleteImageFromStorage(result.path);
    if (result.thumbnailPath) await deleteImageFromStorage(result.thumbnailPath).catch(() => undefined);
    throw new AppError(`Image uploaded, but media metadata could not be saved: ${mediaError.message}`, 500, [mediaError]);
  }

  // Generate the responsive AVIF/WebP ladder in the background — the upload
  // responds immediately with the original + thumbnail so it stays fast.
  const buffer = req.file.buffer;
  void generateResponsiveVariants(media.id, buffer, folder, result.path).catch(() => undefined);

  return sendSuccess(res, 'Image uploaded successfully.', { ...result, media }, 201);
});

export const uploadVideo = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Video file is required.', 400);

  const folder = typeof req.body.folder === 'string' ? req.body.folder : 'videos';
  const result = await uploadVideoToStorage(req.file, folder);

  const { data: media, error: mediaError } = await supabase.from('media_library').insert({
    alt_text: req.body.alt_text ?? null,
    caption: req.body.caption ?? null,
    file_name: req.file.originalname,
    file_path: result.path,
    file_size: result.size,
    file_type: 'video',
    file_url: result.url,
    mime_type: result.mimeType,
    uploaded_by: req.user?.sub ?? null
  }).select('*').single();

  if (mediaError) {
    await deleteImageFromStorage(result.path);
    throw new AppError(`Video uploaded, but media metadata could not be saved: ${mediaError.message}`, 500, [mediaError]);
  }

  return sendSuccess(res, 'Video uploaded successfully.', { ...result, media }, 201);
});

export const uploadLottie = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Lottie file is required.', 400);

  const folder = typeof req.body.folder === 'string' ? req.body.folder : 'lottie';
  const result = await uploadLottieToStorage(req.file, folder);

  const { data: media, error: mediaError } = await supabase.from('media_library').insert({
    alt_text: req.body.alt_text ?? null,
    caption: req.body.caption ?? null,
    file_name: req.file.originalname,
    file_path: result.path,
    file_size: result.size,
    file_type: 'document',
    file_url: result.url,
    mime_type: result.mimeType,
    uploaded_by: req.user?.sub ?? null
  }).select('*').single();

  if (mediaError) {
    await deleteImageFromStorage(result.path);
    throw new AppError(`Lottie file uploaded, but media metadata could not be saved: ${mediaError.message}`, 500, [mediaError]);
  }

  return sendSuccess(res, 'Lottie file uploaded successfully.', { ...result, media }, 201);
});

export const deleteImage = asyncHandler(async (req, res) => {
  const path = typeof req.body.path === 'string' ? req.body.path : '';
  if (!path) throw new AppError('Image path is required.', 422);

  await deleteImageFromStorage(path);
  return sendSuccess(res, 'Image deleted successfully.');
});
