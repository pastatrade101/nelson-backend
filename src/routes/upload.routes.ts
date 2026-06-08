import { Router } from 'express';
import multer from 'multer';
import { deleteImage, uploadImage, uploadLottie } from '../controllers/upload.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { AppError } from '../utils/api-response';

const router = Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      callback(new AppError('Only jpg, jpeg, png, and webp images are allowed.', 400));
      return;
    }

    callback(null, true);
  }
});

const lottieUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    const isJsonMime = ['application/json', 'application/octet-stream', 'text/json'].includes(file.mimetype);
    const isJsonFile = file.originalname.toLowerCase().endsWith('.json');
    if (!isJsonMime && !isJsonFile) {
      callback(new AppError('Only Lottie JSON files are allowed.', 400));
      return;
    }

    callback(null, true);
  }
});

router.post('/image', authenticate, requirePermission('media.upload'), imageUpload.single('image'), uploadImage);
router.post('/lottie', authenticate, requirePermission('media.upload'), lottieUpload.single('lottie'), uploadLottie);
router.delete('/image', authenticate, requirePermission('media.delete'), deleteImage);

export default router;
