import { Router } from 'express';
import { getPublicSettings } from '../controllers/settings.controller';

const router = Router();

// Public, unauthenticated configuration for the website (only is_public settings).
router.get('/settings', getPublicSettings);

export default router;
