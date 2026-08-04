import { env } from '../config/env';

// ----------------------------------------------------------------------------
// Microsoft Clarity — Data Export API (backend only; the token never touches the
// frontend). This is the ONLY programmatic Clarity data that exists: aggregated
// metrics for the last ≤3 days (sessions, scroll depth, engagement, rage/dead
// clicks, quick-backs) plus breakdowns by device/browser/country/URL. Session
// recordings and heatmaps never leave Clarity's UI — those are deep-linked, not
// fetched. We NEVER fabricate: missing metrics come back null.
//
// Hard limit: 10 API requests / project / day. We cache aggressively and cap the
// number of network calls per day so we can never exceed it. Fail-silent so the
// dashboard degrades to an onboarding state instead of erroring.
// ----------------------------------------------------------------------------

export const isClarityConfigured = (): boolean => Boolean(env.CLARITY_API_TOKEN);

const API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';

type Tally = Array<{ label: string; value: number }>;

export type ClarityInsights = {
  configured: boolean;
  error?: string;
  /** Rolling window the numbers cover (Clarity export is limited to ≤3 days). */
  windowDays: number;
  fetchedAt: string | null;
  /** Real aggregate metrics — null when Clarity doesn't return them. */
  totals: {
    sessions: number | null;
    botSessions: number | null;
    distinctUsers: number | null;
    pagesPerSession: number | null;
    avgScrollDepth: number | null; // percent 0–100
    totalTimeMs: number | null;
    activeTimeMs: number | null;
    rageClicks: number | null;
    deadClicks: number | null;
    excessiveScroll: number | null;
    quickBacks: number | null;
    scriptErrors: number | null;
    errorClicks: number | null;
  };
  byDevice: Tally;
  byBrowser: Tally;
  byCountry: Tally;
  byUrl: Tally;
};

const emptyTotals = (): ClarityInsights['totals'] => ({
  sessions: null, botSessions: null, distinctUsers: null, pagesPerSession: null,
  avgScrollDepth: null, totalTimeMs: null, activeTimeMs: null, rageClicks: null,
  deadClicks: null, excessiveScroll: null, quickBacks: null, scriptErrors: null, errorClicks: null
});

const EMPTY = (configured: boolean, error?: string): ClarityInsights => ({
  configured, error, windowDays: 3, fetchedAt: null,
  totals: emptyTotals(), byDevice: [], byBrowser: [], byCountry: [], byUrl: []
});

// ── numeric helpers (Clarity field names drift by metric; read defensively) ───
const firstNum = (obj: Record<string, unknown>, keys: string[]): number | null => {
  for (const k of keys) {
    const v = obj?.[k];
    const n = typeof v === 'string' ? Number(v) : (v as number);
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
};
const firstStr = (obj: Record<string, unknown>, keys: string[]): string | null => {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

// Clarity returns an array of { metricName, information: [...] }. Pull the rows
// for a given metric name (case-insensitive), or [] if absent.
type ClarityMetric = { metricName?: string; information?: Array<Record<string, unknown>> };
const rowsFor = (payload: ClarityMetric[], name: string): Array<Record<string, unknown>> => {
  const m = (payload ?? []).find((x) => String(x?.metricName ?? '').toLowerCase() === name.toLowerCase());
  return Array.isArray(m?.information) ? (m!.information as Array<Record<string, unknown>>) : [];
};
const scalar = (payload: ClarityMetric[], name: string, keys: string[]): number | null => {
  const row = rowsFor(payload, name)[0];
  return row ? firstNum(row, keys) : null;
};

const parseTotals = (payload: ClarityMetric[]): ClarityInsights['totals'] => ({
  sessions: scalar(payload, 'Traffic', ['totalSessionCount', 'sessionsCount', 'totalSessions']),
  botSessions: scalar(payload, 'Traffic', ['totalBotSessionCount', 'botSessionsCount']),
  distinctUsers: scalar(payload, 'Traffic', ['distinctUserCount', 'distantUserCount', 'distinctUsers']),
  pagesPerSession: scalar(payload, 'Traffic', ['pagesPerSessionPercentage', 'pagesPerSession']),
  avgScrollDepth: scalar(payload, 'ScrollDepth', ['averageScrollDepth', 'avgScrollDepth', 'scrollDepth']),
  totalTimeMs: scalar(payload, 'EngagementTime', ['totalTime', 'totalTimeMs']),
  activeTimeMs: scalar(payload, 'EngagementTime', ['activeTime', 'activeTimeMs']),
  rageClicks: scalar(payload, 'RageClickCount', ['subTotal', 'count', 'rageClickCount', 'totalCount']),
  deadClicks: scalar(payload, 'DeadClickCount', ['subTotal', 'count', 'deadClickCount', 'totalCount']),
  excessiveScroll: scalar(payload, 'ExcessiveScroll', ['subTotal', 'count', 'totalCount']),
  quickBacks: scalar(payload, 'QuickbackClick', ['subTotal', 'count', 'totalCount']),
  scriptErrors: scalar(payload, 'ScriptErrorCount', ['subTotal', 'count', 'totalCount']),
  errorClicks: scalar(payload, 'ErrorClickCount', ['subTotal', 'count', 'totalCount'])
});

// Turn a dimension-broken Traffic metric into a {label,value} session tally.
const parseBreakdown = (payload: ClarityMetric[], dimKeys: string[]): Tally =>
  rowsFor(payload, 'Traffic')
    .map((row) => ({
      label: firstStr(row, dimKeys) ?? '(unknown)',
      value: firstNum(row, ['totalSessionCount', 'sessionsCount', 'totalSessions']) ?? 0
    }))
    .filter((r) => r.label !== '(unknown)' && r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

// ── network with a hard daily budget so we never breach Clarity's 10/day cap ──
const call = async (dimension?: string): Promise<ClarityMetric[]> => {
  const params = new URLSearchParams({ numOfDays: '3' });
  if (dimension) params.set('dimension1', dimension);
  const res = await fetch(`${API}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${env.CLARITY_API_TOKEN}`, Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Clarity API ${res.status}`);
  const json = (await res.json()) as unknown;
  return Array.isArray(json) ? (json as ClarityMetric[]) : [];
};

// ── TTL cache + per-UTC-day call counter ──────────────────────────────────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_CALLS_PER_DAY = 8; // < Clarity's 10 limit, leaves headroom
let cache: { at: number; data: ClarityInsights } | null = null;
let dayKey = '';
let callsToday = 0;

const budget = (n: number): boolean => {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dayKey) { dayKey = today; callsToday = 0; }
  if (callsToday + n > MAX_CALLS_PER_DAY) return false;
  callsToday += n;
  return true;
};

/**
 * Real Clarity aggregates for the last 3 days. Cached 6h and rate-limit-guarded.
 * `force` bypasses the cache (still respects the daily budget). Never throws.
 */
export const getClarityInsights = async (force = false): Promise<ClarityInsights> => {
  if (!isClarityConfigured()) return EMPTY(false);
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  // 5 calls: totals + 4 breakdowns. Serve stale cache if it would breach the cap.
  if (!budget(5)) return cache?.data ?? EMPTY(true, 'Daily Clarity API budget reached — showing cached data.');

  try {
    const [totals, dev, brow, ctry, url] = await Promise.all([
      call(),
      call('Device'),
      call('Browser'),
      call('Country'),
      call('URL')
    ]);
    const data: ClarityInsights = {
      configured: true,
      windowDays: 3,
      fetchedAt: new Date().toISOString(),
      totals: parseTotals(totals),
      byDevice: parseBreakdown(dev, ['Device', 'device', 'DeviceType']),
      byBrowser: parseBreakdown(brow, ['Browser', 'browser']),
      byCountry: parseBreakdown(ctry, ['Country', 'country', 'Country/Region']),
      byUrl: parseBreakdown(url, ['URL', 'url', 'Url', 'Page'])
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Clarity export failed';
    return cache?.data ?? EMPTY(true, msg);
  }
};
