import { Router } from 'express';
import {
  getAnalyticsFunnel,
  getAnalyticsLeads,
  getAnalyticsOverview,
  getAnalyticsTimeseries,
  getAnalyticsTraffic,
  getIntegrations,
  trackEvent
} from '../controllers/analytics.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { analyticsEventLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { trackEventSchema } from '../schemas/analytics.schema';

const router = Router();

// Public, PII-free event ingestion (rate-limited, allowlisted event names).
router.post('/events', analyticsEventLimiter, validate({ body: trackEventSchema }), trackEvent);

// Admin reads — reuse the dashboard permission.
router.get('/overview', authenticate, requirePermission('dashboard.view'), getAnalyticsOverview);
router.get('/leads', authenticate, requirePermission('dashboard.view'), getAnalyticsLeads);
router.get('/funnel', authenticate, requirePermission('dashboard.view'), getAnalyticsFunnel);
router.get('/timeseries', authenticate, requirePermission('dashboard.view'), getAnalyticsTimeseries);
router.get('/traffic', authenticate, requirePermission('dashboard.view'), getAnalyticsTraffic);
router.get('/integrations', authenticate, requirePermission('dashboard.view'), getIntegrations);

export default router;
