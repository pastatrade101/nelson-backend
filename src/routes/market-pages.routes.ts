import { Router } from 'express';
import {
  createMarketPage,
  deleteMarketPage,
  getMarketPageBySlug,
  listMarketPages,
  updateMarketPage
} from '../controllers/market-pages.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { marketPageCreateSchema, marketPageUpdateSchema } from '../schemas/market-pages.schema';

const router = Router();

router.get('/', listMarketPages);
router.get('/:slug', getMarketPageBySlug);
router.post('/', authenticate, requirePermission('market_pages.create'), validate({ body: marketPageCreateSchema }), createMarketPage);
router.put('/:id', authenticate, requirePermission('market_pages.update'), validate({ body: marketPageUpdateSchema }), updateMarketPage);
router.delete('/:id', authenticate, requirePermission('market_pages.delete'), deleteMarketPage);

export default router;
