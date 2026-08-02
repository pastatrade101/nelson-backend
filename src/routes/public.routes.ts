import { Router } from 'express';
import { getPublicSettings } from '../controllers/settings.controller';
import { resolveImageVariants } from '../controllers/media.controller';

const router = Router();

// Public, unauthenticated configuration for the website (only is_public settings).
router.get('/settings', getPublicSettings);

// Public batch resolver for responsive image metadata (see controller).
router.get('/image-variants', resolveImageVariants);

export default router;
