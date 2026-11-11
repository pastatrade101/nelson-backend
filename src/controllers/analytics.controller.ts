import { createHmac } from 'crypto';
import type { Request } from 'express';
import {
  getEventTimeseries,
  getFunnel,
  getLeadAnalytics,
  getMainLeads,
  getOverview,
  recordEvent,
  resolveRange
} from '../services/analytics.service';
import { env } from '../config/env';
import { getTraffic, isGa4Configured } from '../services/ga4.service';
import { getClarityInsights, isClarityConfigured } from '../services/clarity.service';
import { getWebsiteIntelligence } from '../services/website-intelligence.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getQueryString } from '../utils/query';

/**
 * The client's network as an opaque daily token (the raw IP is never stored).
 * It is an HMAC keyed with a server-only secret over the UTC date and the IP:
 * without the key it cannot be reversed by hashing every address, and a new
 * date gives a new token, so one network cannot be followed from day to day.
 * The automated-traffic rule only compares networks within one UTC day, which
 * is all this needs to support. Rows stored before this change hold the older,
 * unkeyed hash.
 */
const IP_HASH_KEY = env.ANALYTICS_IP_SECRET || env.JWT_SECRET;
const hashIp = (req: Request): string | null => {
  const fwd = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim();
  const ip = fwd || req.ip || '';
  if (!ip) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHmac('sha256', IP_HASH_KEY).update(`${day}|${ip}`).digest('hex').slice(0, 40);
};

// The caller's User-Agent: the ingest refuses crawlers, uptime checks, link
// previews and scripts by it (never stored).
const userAgent = (req: Request): string | null => req.get('user-agent') ?? null;

const rangeFromQuery = (req: Request) =>
  resolveRange(getQueryString(req.query, 'range'), getQueryString(req.query, 'from'), getQueryString(req.query, 'to'));

// ── public ingest ────────────────────────────────────────────────────────────
// Body is validated + allowlisted by trackEventSchema. Always 202s, never errors
// the client (analytics must fail silently).
export const trackEvent = asyncHandler(async (req, res) => {
  await recordEvent(req.body, hashIp(req), userAgent(req));
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

// The three main leads (Plan My Trip, the itinerary form, WhatsApp): counts,
// funnels, first-touch sources, and how the in-house tracker, the database and
// GA4 agree. Development and automated traffic are excluded throughout; `ok`
// is false when a read failed and the report is the empty shape.
export const getAnalyticsMainLeads = asyncHandler(async (req, res) => {
  const data = await getMainLeads(rangeFromQuery(req));
  return sendSuccess(res, 'Main leads fetched.', data);
});

// GA4 traffic (Phase 2). Returns { configured: false } when GA4 isn't set up.
export const getAnalyticsTraffic = asyncHandler(async (req, res) => {
  const data = await getTraffic(rangeFromQuery(req));
  return sendSuccess(res, 'GA4 traffic fetched.', data);
});

// Microsoft Clarity real aggregates (Data Export API). { configured: false } when
// no CLARITY_API_TOKEN — the dashboard then shows deep-links + an onboarding state.
export const getAnalyticsClarity = asyncHandler(async (req, res) => {
  const force = getQueryString(req.query, 'refresh') === '1';
  const data = await getClarityInsights(force);
  return sendSuccess(res, 'Clarity UX insights fetched.', data);
});

// Website Intelligence — a deterministic rules engine over the real analytics:
// health/category scores, executive summary, rule-based alerts, prioritized
// actions, previous-period benchmarks, a real event timeline and the
// plain-words interpretation of the main leads (headline + findings).
export const getAnalyticsIntelligence = asyncHandler(async (req, res) => {
  const data = await getWebsiteIntelligence(rangeFromQuery(req));
  return sendSuccess(res, 'Website intelligence fetched.', data);
});

// Integration status (no secrets returned) — powers /admin/settings/integrations.
export const getIntegrations = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Integration status.', {
    ga4: { configured: isGa4Configured() },
    clarity: { configured: isClarityConfigured(), projectId: env.CLARITY_PROJECT_ID || null },
    hubspot: { configured: Boolean(env.HUBSPOT_ACCESS_TOKEN), portalId: env.HUBSPOT_PORTAL_ID || null },
    whatsappCloudApi: { configured: Boolean(env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) },
    aiAdvisor: { configured: Boolean(env.ANTHROPIC_API_KEY) },
    turnstile: { configured: Boolean(env.TURNSTILE_SECRET_KEY) }
  });
});
