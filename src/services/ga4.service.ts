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
    const raw = error instanceof Error ? error.message : 'GA4 request failed';
    // eslint-disable-next-line no-console
    console.error('[ga4] request failed:', raw);
    // Turn the common misconfigurations into an actionable hint rather than a
    // raw OpenSSL/gRPC error in the admin dashboard.
    const friendly = /DECODER|PEM|private key|1E08010C|routines/i.test(raw)
      ? 'GA4 service-account key looks invalid. Set GOOGLE_PRIVATE_KEY on ONE line with literal \\n and no surrounding quotes.'
      : /PERMISSION_DENIED|permission|forbidden|403/i.test(raw)
        ? 'GA4 permission denied. Add the service-account email as a Viewer on the GA4 property (Admin → Property Access Management).'
        : /NOT_FOUND|property/i.test(raw)
          ? 'GA4 property not found. Check GA4_PROPERTY_ID is the numeric property ID (not the G- measurement ID).'
          : raw;
    return EMPTY(true, friendly);
  }
};
