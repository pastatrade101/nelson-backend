import { Router } from 'express';
import multer from 'multer';
import { importItinerariesCsv } from '../controllers/itinerary-import.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

const router = Router();

// Bulk import itineraries from a CSV (admin, needs tour create rights).
router.post('/', authenticate, requirePermission('tours.create'), upload.single('file'), importItinerariesCsv);

export default router;
