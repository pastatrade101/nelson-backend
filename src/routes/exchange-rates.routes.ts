import { Router } from 'express';
import { getExchangeRateStatus, refreshExchangeRates } from '../controllers/exchange-rates.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { exchangeRateRefreshLimiter } from '../middleware/rate-limit.middleware';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('exchange_rates.view'), getExchangeRateStatus);
router.post('/refresh', requirePermission('exchange_rates.refresh'), exchangeRateRefreshLimiter, refreshExchangeRates);

export default router;
