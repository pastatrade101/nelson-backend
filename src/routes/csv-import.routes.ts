import { Router } from 'express';
import multer from 'multer';
import { getImportEntities, getImportTemplate, getResetInfo, importCsvEntity, resetContentData } from '../controllers/csv-import.controller';
import { authenticate } from '../middleware/auth.middleware';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

// All routes require an authenticated admin; per-entity permission is enforced
// inside the controller (the entity is a URL param).
router.get('/entities', authenticate, getImportEntities);
// Danger zone — reset all importable content (super-admin only, enforced in the controller).
router.get('/reset', authenticate, getResetInfo);
router.post('/reset', authenticate, resetContentData);
router.get('/:entity/template', authenticate, getImportTemplate);
router.post('/:entity', authenticate, upload.single('file'), importCsvEntity);

export default router;
