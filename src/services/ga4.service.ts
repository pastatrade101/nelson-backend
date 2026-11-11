import { env } from '../config/env';
import type { ResolvedRange } from './analytics.service';

// ----------------------------------------------------------------------------
// GA4 Data API (Phase 2). Backend-only — credentials never touch the frontend.
// Returns { configured: false } when env vars are missing, and fails silently
// (never throws) so the dashboard degrades gracefully. Responses are cached to
// respect GA4 Data API quotas (don't hit Google on every dashboard load).
// ----------------------------------------------------------------------------

export const isGa4Configured = (): boolean =>
  Boolean(env.GA4_PROPERTY_ID && env.GOOGLE_CLIENT_EMAIL && env.GOOGLE_PRIVATE_KEY);

type Tally = Array<{ label: string; value: number }>;
export type Ga4Traffic = {
  configured: boolean;
  error?: string;
  activeUsers: number;
  totalUsers: number;
  sessions: number;
  pageViews: number;
  byDay: Array<{ date: string; users: number; sessions: number; pageViews: number }>;
  topPages: Tally;
  sources: Tally;
  countries: Tally;
  devices: Tally;
};

const EMPTY = (configured: boolean, error?: string): Ga4Traffic => ({
  configured, error, activeUsers: 0, totalUsers: 0, sessions: 0, pageViews: 0,
  byDay: [], topPages: [], sources: [], countries: [], devices: []
});

// Lazily create the client (dynamic import keeps the heavy SDK out of cold paths).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let clientPromise: Promise<any> | null = null;
const getClient = async () => {
  if (!isGa4Configured()) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      const { BetaAnalyticsDataClient } = await import('@google-analytics/data');
      return new BetaAnalyticsDataClient({
        credentials: {
          client_email: env.GOOGLE_CLIENT_EMAIL,
          // Host env stores the key with literal "\n"; un-escape to real newlines.
          private_key: (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
        }
      });
    })().catch(() => null);
  }
  return clientPromise;
};

// ── tiny TTL cache ───────────────────────────────────────────────────────────
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; data: Ga4Traffic }>();

const toGa4Date = (iso: string) => iso.slice(0, 10);
const minusOneDay = (iso: string) => new Date(new Date(iso).getTime() - 86_400_000).toISOString().slice(0, 10);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rowsToTally = (report: any, valueIndex = 0): Tally =>
  (report?.rows ?? []).map((r: any) => ({
    label: r.dimensionValues?.[0]?.value ?? '(not set)',
    value: Number(r.metricValues?.[valueIndex]?.value ?? 0)
  }));

export const getTraffic = async (range: ResolvedRange): Promise<Ga4Traffic> => {
  if (!isGa4Configured()) return EMPTY(false);

  const startDate = toGa4Date(range.fromIso);
  const endDate = minusOneDay(range.toIso); // toIso is exclusive (start of next day)
  const cacheKey = `${startDate}:${endDate}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  try {
    const client = await getClient();
    if (!client) return EMPTY(true, 'GA4 client unavailable');
    const property = `properties/${env.GA4_PROPERTY_ID}`;
    const dateRanges = [{ startDate, endDate }];

    // One batched call (5 reports) keeps us well within quota.
    const [batch] = await client.batchRunReports({
      property,
      requests: [
        { dateRanges, dimensions: [{ name: 'date' }], metrics: [{ name: 'totalUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }], orderBys: [{ dimension: { dimensionName: 'date' } }] },
        { dateRanges, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], limit: 10, orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }] },
        { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], limit: 8, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] },
        { dateRanges, dimensions: [{ name: 'country' }], metrics: [{ name: 'totalUsers' }], limit: 8, orderBys: [{ metric: { metricName: 'totalUsers' }, desc: true }] },
        { dateRanges, dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'totalUsers' }] }
      ]
    });

    const reports = batch?.reports ?? [];
    const byDayReport = reports[0];
    const byDay = (byDayReport?.rows ?? []).map((r: any) => {
      const d = r.dimensionValues?.[0]?.value ?? '';
      return {
        date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
        users: Number(r.metricValues?.[0]?.value ?? 0),
        sessions: Number(r.metricValues?.[1]?.value ?? 0),
        pageViews: Number(r.metricValues?.[2]?.value ?? 0)
      };
    });

    const sum = (k: 'users' | 'sessions' | 'pageViews') => byDay.reduce((acc: number, d: any) => acc + d[k], 0);

    // Realtime active users (separate endpoint).
    let activeUsers = 0;
    try {
      const [rt] = await client.runRealtimeReport({ property, metrics: [{ name: 'activeUsers' }] });
      activeUsers = Number(rt?.rows?.[0]?.metricValues?.[0]?.value ?? 0);
    } catch {
      // realtime is optional
    }

    const data: Ga4Traffic = {
      configured: true,
      activeUsers,
      totalUsers: sum('users'),
      sessions: sum('sessions'),
      pageViews: sum('pageViews'),
      byDay,
      topPages: rowsToTally(reports[1]),
      sources: rowsToTally(reports[2]),
      countries: rowsToTally(reports[3]),
      devices: rowsToTally(reports[4])
    };
    cache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch (error) {
    return EMPTY(true, error instanceof Error ? error.message : 'GA4 request failed');
  }
};

// ── Where the property's visits come from ───────────────────────────────────
// When GA4 goes quiet while the site still has visitors, the usual cause is a
// tag sending to another property. The host name of the property's last
// visits tells the owner which site this property is actually measuring.
export type Ga4LastHost = { host: string; date: string };

let lastHostCache: { at: number; data: Ga4LastHost | null } | null = null;

/**
 * The host name that received the property's most recent sessions (the
 * busiest host on GA4's latest day with any, within the last 90 days), and
 * that day as 'YYYY-MM-DD'. null when GA4 is not configured, has no sessions
 * in that window, or the request fails. Never throws.
 */
export const getGa4LastHost = async (): Promise<Ga4LastHost | null> => {
  if (!isGa4Configured()) return null;
  if (lastHostCache && Date.now() - lastHostCache.at < CACHE_TTL_MS) return lastHostCache.data;
  try {
    const client = await getClient();
    if (!client) return null;
    const [report] = await client.runReport({
      property: `properties/${env.GA4_PROPERTY_ID}`,
      dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }, { name: 'hostName' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ dimension: { dimensionName: 'date' }, desc: true }, { metric: { metricName: 'sessions' }, desc: true }],
      limit: 5
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = (report?.rows ?? []).find((r: any) => Number(r.metricValues?.[0]?.value ?? 0) > 0);
    const d: string = row?.dimensionValues?.[0]?.value ?? '';
    const host: string = row?.dimensionValues?.[1]?.value ?? '';
    const data = row && host && host !== '(not set)' && d.length === 8
      ? { host, date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` }
      : null;
    lastHostCache = { at: Date.now(), data };
    return data;
  } catch {
    return null;
  }
};

// ── Main-lead events (reconciliation with the in-house tracker) ─────────────
// The site sends these to GA4 itself (gtag, never through GTM tags): a sent
// planner or itinerary form arrives as generate_lead with lead_source set to
// the channel, a WhatsApp tap as whatsapp_click, and the form milestones under
// their own names. The CMS sets these counts beside its own to show whether
// the two trackers agree.
export const GA4_LEAD_EVENT_NAMES = [
  'generate_lead', 'whatsapp_click', 'form_opened', 'form_started', 'form_step_completed', 'form_abandoned'
] as const;

export type Ga4LeadEvents = {
  /** eventCount per name in range, every name present (0 when none). */
  events: Array<{ name: string; count: number }>;
  /**
   * generate_lead split by its lead_source parameter ('plan_my_trip',
   * 'itinerary_form', '(not set)' for older sends). null when lead_source is
   * not registered as a custom dimension in GA4 — the Data API refuses the
   * dimension then, and there is nothing truthful to show.
   */
  leadSources: Record<string, number> | null;
};

const leadCache = new Map<string, { at: number; data: Ga4LeadEvents }>();

/** GA4 counts for the main-lead events. null when GA4 is not configured or fails. Never throws. */
export const getGa4LeadEvents = async (range: ResolvedRange): Promise<Ga4LeadEvents | null> => {
  if (!isGa4Configured()) return null;

  const startDate = toGa4Date(range.fromIso);
  const endDate = minusOneDay(range.toIso); // toIso is exclusive (start of next day)
  const cacheKey = `${startDate}:${endDate}`;
  const hit = leadCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  try {
    const client = await getClient();
    if (!client) return null;
    const property = `properties/${env.GA4_PROPERTY_ID}`;
    const dateRanges = [{ startDate, endDate }];

    const [report] = await client.runReport({
      property,
      dateRanges,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: [...GA4_LEAD_EVENT_NAMES] } } }
    });
    const counts = new Map(rowsToTally(report).map((row) => [row.label, row.value]));
    const events = GA4_LEAD_EVENT_NAMES.map((name) => ({ name, count: counts.get(name) ?? 0 }));

    // A separate request on purpose: an unregistered custom dimension fails the
    // whole request, and the plain counts above must survive that.
    let leadSources: Record<string, number> | null = null;
    try {
      const [split] = await client.runReport({
        property,
        dateRanges,
        dimensions: [{ name: 'customEvent:lead_source' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: { filter: { fieldName: 'eventName', stringFilter: { value: 'generate_lead' } } }
      });
      leadSources = Object.fromEntries(rowsToTally(split).map((row) => [row.label, row.value]));
    } catch {
      leadSources = null; // lead_source not registered as a custom dimension
    }

    const data: Ga4LeadEvents = { events, leadSources };
    leadCache.set(cacheKey, { at: Date.now(), data });
    return data;
  } catch {
    return null;
  }
};
