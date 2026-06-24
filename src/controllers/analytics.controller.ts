import { createHash } from 'crypto';
import type { Request } from 'express';
import {
  getEventTimeseries,
  getFunnel,
  getLeadAnalytics,
  getOverview,
  recordEvent,
  resolveRange
} from '../services/analytics.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';

// Hash the client IP (never store raw). Weak abuse signal only.
const hashIp = (req: Request): string | null => {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  const ip = fwd || req.ip || '';
  if (!ip) return null;
  return createHash('sha256').update(`goldfinch-analytics:${ip}`).digest('hex').slice(0, 40);
};

const rangeFromQuery = (req: Request) =>
  resolveRange(getQueryString(req.query, 'range'), getQueryString(req.query, 'from'), getQueryString(req.query, 'to'));

// ── public ingest ────────────────────────────────────────────────────────────
// Body is validated + allowlisted by trackEventSchema. Always 202s, never errors
// the client (analytics must fail silently).
export const trackEvent = asyncHandler(async (req, res) => {
  await recordEvent(req.body, hashIp(req));
  return sendSuccess(res, 'Event received.', { received: true }, 202);
});

// ── admin reads ──────────────────────────────────────────────────────────────
export const getAnalyticsOverview = asyncHandler(async (req, res) => {
  const data = await getOverview(rangeFromQuery(req));
  return sendSuccess(res, 'Analytics overview fetched.', data);
});

export const getAnalyticsLeads = asyncHandler(async (req, res) => {
  const data = await getLeadAnalytics(rangeFromQuery(req));
  return sendSuccess(res, 'Lead analytics fetched.', data);
});

export const getAnalyticsFunnel = asyncHandler(async (req, res) => {
  const data = await getFunnel(rangeFromQuery(req));
  return sendSuccess(res, 'Funnel analytics fetched.', data);
});

export const getAnalyticsTimeseries = asyncHandler(async (req, res) => {
  const data = await getEventTimeseries(rangeFromQuery(req));
  return sendSuccess(res, 'Traffic timeseries fetched.', data);
});
