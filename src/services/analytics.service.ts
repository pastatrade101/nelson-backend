import { env } from '../config/env';
import { supabase } from '../config/supabase';
import type { TrackEventInput } from '../schemas/analytics.schema';
import { isClarityConfigured } from './clarity.service';
import { getGa4LeadEvents, isGa4Configured } from './ga4.service';

// ----------------------------------------------------------------------------
// Phase 1 analytics: first-party events (analytics_events) + lead/business data
// (booking_requests). Traffic dimensions like real visitors, sources, countries
// come from GA4 in Phase 2; here we derive what we can from first-party data.
// Every read is fail-silent so the dashboard never errors the app.
// ----------------------------------------------------------------------------

// Defence-in-depth: never persist personal fields even if a caller slips them
// into metadata. PII belongs in booking_requests, never in analytics.
const PII_KEYS = new Set([
  'full_name', 'name', 'first_name', 'last_name', 'fullname',
  'email', 'phone', 'whatsapp', 'whatsapp_number', 'tel',
  'message', 'notes', 'trip_notes', 'special_requests', 'password'
]);

const scrubMetadata = (metadata?: Record<string, unknown> | null): Record<string, unknown> => {
  if (!metadata || typeof metadata !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (PII_KEYS.has(key.toLowerCase())) continue;
    if (typeof value === 'string' && value.length > 500) continue; // free-text guard
    out[key] = value;
  }
  return out;
};

// The validated, non-personal context the frontend sends beside each event —
// which form, which step, which button, which tour. analytics_events has no
// column for any of it, so it lives in metadata. Before this it was validated
// at the edge and then dropped, and no report could tell one form, step or
// WhatsApp button from another.
const CONTEXT_KEYS = [
  'form_name', 'form_type', 'lead_type', 'step_index', 'step_key', 'field_name', 'error_type', 'error_code',
  'cta_name', 'cta_type', 'cta_location', 'page_section', 'method', 'tour_slug', 'list_name', 'item_position',
  'filter_name', 'sort_option', 'search_term', 'results_count', 'category_id', 'category_name', 'tour_name',
  'safari_style', 'accommodation_level', 'duration_days', 'price_from', 'currency', 'transaction_id'
] as const satisfies ReadonlyArray<keyof TrackEventInput>;

const contextMetadata = (input: TrackEventInput): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of CONTEXT_KEYS) {
    const value = input[key];
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  // The one field a visitor types into freely: the same guard as the
  // frontend's safeSearchTerm, so an email or phone pasted into search never lands.
  const term = out.search_term;
  if (typeof term === 'string' && (term.length > 64 || /@|\d{7,}/.test(term))) delete out.search_term;
  return out;
};

// Local development talks to the live database, so before the frontend gate a
// developer's clicks landed in analytics_events as if they were visitors — more
// than half of every row stored. Not traffic: localhost and its kin, any IP
// address (a LAN dev server, the VPS's own address after a deploy) and any
// explicit port (:5174, :3000). The live site is a real domain on 443. The
// ingest refuses these now; every report also skips the rows already there.
const NON_TRAFFIC_HOST = /^(localhost|0\.0\.0\.0|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$|\.(localhost|local|test|internal|lan)$/i;
const isDevHostUrl = (url: string | null | undefined): boolean => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return Boolean(u.port) || NON_TRAFFIC_HOST.test(u.hostname);
  } catch {
    return false;
  }
};

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// ── automated traffic ────────────────────────────────────────────────────────
// Crawlers, uptime checks, link previews and scripts announce themselves in
// the User-Agent: the ingest refuses them. The tracker stores no user agent,
// so what slipped in before (or hides its agent) is told by its shape instead:
// on 29 Sep 2026, 18 networks each opened 11–17 fresh sessions within about an
// hour, while on no other day since tracking began did a network open more than
// 10. The same evening 210 more sessions spread over many networks began in two
// hours (139 from 18:00 UTC, 71 from 19:00), every one a desktop session that
// viewed one or two pages and did nothing else; since 1 Aug no other hour saw
// more than 19 new visitor sessions.
//
// The agent test matches whole tokens, never letters inside a word: a bare
// "bot" inside a phone model ("CUBOT X50" in an Android WebView) is a visitor.
// Crawlers that weld the word to their name are listed by name.
const AUTOMATED_AGENT = new RegExp(
  [
    // "bot", "crawler", "spider"… as a word of their own: "Pingdom.com_bot", "(compatible; crawler)".
    '(^|[^a-z])(bot|robot|crawler|crawl|spider|scraper|slurp)([^a-z]|$)',
    // Product tokens that end in "bot" and carry a version: "SiteAuditBot/0.97", "XYZbot/2".
    '[a-z]bot/[0-9v]',
    // Crawlers, previews and AI fetchers known by name.
    'googlebot|adsbot|bingbot|bingpreview|yandexbot|duckduckbot|baiduspider|bytespider|applebot|ahrefsbot|semrushbot|' +
      'mj12bot|dotbot|petalbot|seznambot|blexbot|dataforseobot|gptbot|oai-searchbot|chatgpt-user|claudebot|claude-user|' +
      'perplexitybot|ccbot|amazonbot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|facebookexternalhit|' +
      'facebookcatalog|meta-externalagent|google-inspectiontool|mediapartners-google|storebot-google|uptimerobot|ia_archiver',
    // Headless browsers, speed and uptime checks, link previews.
    'headless|phantomjs|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|preview|^whatsapp/',
    // Scripts and HTTP libraries.
    '(^|[^a-z])(curl|wget|python|python-requests|python-urllib|aiohttp|scrapy|axios|node-fetch|undici|go-http-client|okhttp|httpclient|libwww-perl)([^a-z]|$)'
  ].join('|'),
  'i'
);
export const isAutomatedAgent = (userAgent: string | null | undefined): boolean =>
  typeof userAgent === 'string' && AUTOMATED_AGENT.test(userAgent);

/** Within one UTC day, a network (ip_hash) opening more sessions than this is automated. */
export const AUTOMATED_SESSIONS_PER_DAY = 10;
/** A UTC hour in which more visitor sessions began than this, site-wide, is a burst… */
export const AUTOMATED_SESSIONS_PER_HOUR = 40;
/** …when at least this share of them viewed at most two pages and did nothing else. */
const BURST_LOW_ENGAGEMENT_SHARE = 0.8;
const LOW_ENGAGEMENT_MAX_PAGES = 2;

type NetworkRow = { event_name: string; session_id: string | null; ip_hash: string | null; created_at: string };
const networkDay = (e: NetworkRow) => `${e.created_at.slice(0, 10)}|${e.ip_hash}`;
const sessionDay = (e: NetworkRow) => `${e.created_at.slice(0, 10)}|${e.session_id}`;

/**
 * The automated-traffic rules, shared by every in-house report. Both judge one
 * UTC day at a time, and a session they catch is left out whole for that day,
 * since one session is one visitor (on 29 Sep 2026, 52 of the burst's
 * sessions also sent events from a second network):
 *  1. a network (ip_hash) that opened more than 10 distinct sessions in one
 *     UTC day is automated, with all its events that day;
 *  2. of what remains, a UTC hour in which more than 40 visitor sessions began
 *     (a session with a page view, by its first event that day), at least 80%
 *     of them viewing at most two pages with no interaction (ACTION_EVENTS),
 *     is a burst: its low-engagement sessions are left out, the others stay.
 * `rows` must hold every event of each day it covers (the reports read whole
 * UTC days) so the counts are complete. Leads in booking_requests are never
 * dropped by this. `excludedSessions` counts distinct sessions left out.
 */
export const withoutAutomated = <T extends NetworkRow>(rows: T[]): { rows: T[]; excludedSessions: number } => {
  // ── rule 1: one network, many sessions in a day ──
  const sessionsPerNetworkDay = new Map<string, Set<string>>();
  for (const e of rows) {
    if (!e.ip_hash || !e.session_id) continue;
    const key = networkDay(e);
    const set = sessionsPerNetworkDay.get(key) ?? new Set<string>();
    set.add(e.session_id);
    sessionsPerNetworkDay.set(key, set);
  }
  const automated = new Set([...sessionsPerNetworkDay].filter(([, set]) => set.size > AUTOMATED_SESSIONS_PER_DAY).map(([key]) => key));
  const droppedSessionDays = new Set<string>();
  for (const e of rows) if (e.ip_hash && e.session_id && automated.has(networkDay(e))) droppedSessionDays.add(sessionDay(e));
  const byNetwork = (e: NetworkRow) =>
    Boolean(e.ip_hash && automated.has(networkDay(e))) || Boolean(e.session_id && droppedSessionDays.has(sessionDay(e)));

  // ── rule 2: a burst of one- or two-page sessions in one hour, site-wide ──
  const visits = new Map<string, { firstAt: string; pages: number; acted: boolean }>();
  for (const e of rows) {
    if (!e.session_id || byNetwork(e)) continue;
    const key = sessionDay(e);
    const visit = visits.get(key) ?? { firstAt: e.created_at, pages: 0, acted: false };
    if (e.created_at < visit.firstAt) visit.firstAt = e.created_at;
    if (e.event_name === PAGE_VIEW) visit.pages += 1;
    if (ACTION_EVENTS.has(e.event_name)) visit.acted = true;
    visits.set(key, visit);
  }
  const hours = new Map<string, { visitors: number; low: string[] }>();
  for (const [key, visit] of visits) {
    if (visit.pages === 0) continue; // not a visitor
    const hour = visit.firstAt.slice(0, 13);
    const bucket = hours.get(hour) ?? { visitors: 0, low: [] };
    bucket.visitors += 1;
    if (visit.pages <= LOW_ENGAGEMENT_MAX_PAGES && !visit.acted) bucket.low.push(key);
    hours.set(hour, bucket);
  }
  for (const { visitors, low } of hours.values()) {
    if (visitors > AUTOMATED_SESSIONS_PER_HOUR && low.length >= BURST_LOW_ENGAGEMENT_SHARE * visitors) {
      for (const key of low) droppedSessionDays.add(key);
    }
  }

  if (!automated.size && !droppedSessionDays.size) return { rows, excludedSessions: 0 };
  const dropped = new Set<string>();
  const kept: T[] = [];
  for (const e of rows) {
    if (byNetwork(e) || (e.session_id && droppedSessionDays.has(sessionDay(e)))) {
      if (e.session_id) dropped.add(e.session_id);
      continue;
    }
    kept.push(e);
  }
  return { rows: kept, excludedSessions: dropped.size };
};

const isDevUrl = isDevHostUrl;
/**
 * The same rule as a POSIX regex for PostgREST (imatch), written without
 * backslashes so it survives the or() filter's quoting: exactly the rows
 * isDevUrl() matches, and every other row (a null URL is kept).
 */
const NON_TRAFFIC_URL_RE =
  '^https?://([^/?#]*[.](localhost|local|test|internal|lan)|localhost|0[.]0[.]0[.]0|[[][^]]*[]]|[0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}|[^/?#]+:[0-9]+)([/?#:]|$)';
const DEV_URL_FILTER = `source_page_url.imatch."${NON_TRAFFIC_URL_RE}"`;
const NOT_DEV_URL_FILTER = `source_page_url.is.null,source_page_url.not.imatch."${NON_TRAFFIC_URL_RE}"`;

// PostgREST returns at most 1000 rows per request (its max-rows), whatever
// .limit() asks for — so every report over a busy range silently saw only the
// first 1000 events. Read every page instead, in a fixed order so pages never
// overlap: the first page brings the total (count: 'exact'), the rest are read
// a few at a time, then any rows that arrived meanwhile. A failed page throws,
// and the caller's fail-silent catch decides: an empty report is honest, a
// half-counted one is not.
const PAGE_SIZE = 1000;
const MAX_ROWS = 200_000;
const PAGES_AT_ONCE = 4;
type PageResult = PromiseLike<{ data: unknown[] | null; error: { message: string } | null; count?: number | null }>;

const readAllPages = async <T>(page: (from: number, to: number) => PageResult): Promise<T[]> => {
  const read = async (from: number): Promise<T[]> => {
    const { data, error } = await page(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    return (data ?? []) as T[];
  };

  const first = await page(0, PAGE_SIZE - 1);
  if (first.error) throw new Error(first.error.message);
  const rows = [...((first.data ?? []) as T[])];
  let last = rows.length;

  const total = Math.min(first.count ?? 0, MAX_ROWS);
  const starts: number[] = [];
  for (let from = PAGE_SIZE; last === PAGE_SIZE && from < total; from += PAGE_SIZE) starts.push(from);
  for (const group of chunk(starts, PAGES_AT_ONCE)) {
    for (const batch of await Promise.all(group.map(read))) {
      rows.push(...batch);
      last = batch.length;
    }
  }
  // Rows that arrived after the count (or no count at all): carry on until a short page.
  while (last === PAGE_SIZE && rows.length < MAX_ROWS) {
    const batch = await read(rows.length);
    rows.push(...batch);
    last = batch.length;
  }
  return rows;
};

export type PurgeResult = { purged: number; cutoff: string; retentionDays: number };

/** Delete analytics events older than ANALYTICS_RETENTION_DAYS. Never throws. */
export const purgeOldEvents = async (): Promise<PurgeResult> => {
  const retentionDays = env.ANALYTICS_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  try {
    const { data, error } = await supabase.from('analytics_events').delete().lt('created_at', cutoff).select('id');
    if (error) return { purged: 0, cutoff, retentionDays };
    return { purged: data?.length ?? 0, cutoff, retentionDays };
  } catch {
    return { purged: 0, cutoff, retentionDays };
  }
};

/** Insert one analytics event. Never throws. */
export const recordEvent = async (input: TrackEventInput, ipHash: string | null, userAgent?: string | null): Promise<void> => {
  try {
    if (isDevHostUrl(input.source_page_url)) return; // development, not traffic
    if (isAutomatedAgent(userAgent)) return; // a crawler or script, not a visitor
    await supabase.from('analytics_events').insert({
      event_name: input.event_name,
      session_id: input.session_id || null,
      page_path: input.page_path || null,
      source_page_url: input.source_page_url || null,
      tour_id: input.tour_id || null,
      tour_title: input.tour_title || null,
      destination: input.destination || null,
      experience_type: input.experience_type || null,
      budget_range: input.budget_range || null,
      traveller_type: input.traveller_type || null,
      device_type: input.device_type || null,
      // Scrubbed caller metadata first; the validated context wins on a clash.
      metadata: { ...scrubMetadata(input.metadata), ...contextMetadata(input) },
      ip_hash: ipHash
    });
  } catch {
    // analytics must never break the request
  }
};

/**
 * Record/refresh a session for attribution. First-touch: the UTM/referrer/landing
 * are written once (on first sight of the session_id) and never overwritten; later
 * beacons only bump last_seen_at + page_views. Never throws.
 */
export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'this_month' | 'last_month' | 'custom';

export type ResolvedRange = { fromIso: string; toIso: string; days: number };

export const resolveRange = (key: string | undefined, from?: string, to?: string): ResolvedRange => {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const today = startOfDay(now);
  const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);
  let start = addDays(today, -29);
  let end = addDays(today, 1); // exclusive upper bound (start of tomorrow)

  switch (key) {
    case 'today': start = today; break;
    case 'yesterday': start = addDays(today, -1); end = today; break;
    case '7d': start = addDays(today, -6); break;
    case '30d': start = addDays(today, -29); break;
    case '90d': start = addDays(today, -89); break;
    case 'this_month': start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); break;
    case 'last_month': {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      break;
    }
    case 'custom': {
      if (from) start = new Date(`${from}T00:00:00.000Z`);
      if (to) end = addDays(new Date(`${to}T00:00:00.000Z`), 1);
      break;
    }
    default: break; // 30d default
  }

  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000));
  return { fromIso: start.toISOString(), toIso: end.toISOString(), days };
};

const dayKey = (iso: string) => iso.slice(0, 10);

// ── raw fetchers ─────────────────────────────────────────────────────────────
type EventRow = {
  event_name: string;
  session_id: string | null;
  ip_hash: string | null;
  page_path: string | null;
  device_type: string | null;
  destination: string | null;
  tour_title: string | null;
  source_page_url: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type BookingRow = {
  id: string;
  source: string | null;
  status: string | null;
  tour_id: string | null;
  lead_context: Record<string, unknown> | null;
  created_at: string;
};

// One page of the CMS asks for the same range several times at once (the
// overview, funnel, timeseries, main leads and the interpretation), so a read
// is shared for a minute — the request in flight included. A failed read is
// never kept.
const EVENTS_SHARED_MS = 60_000;
const eventReads = new Map<string, { at: number; read: Promise<EventRow[]> }>();

/**
 * Every event in range from real visitors — development rows are skipped.
 * Throws when a page fails to read; callers decide whether that is silent.
 * The rows are shared between callers: filter, never mutate.
 */
const readEvents = (fromIso: string, toIso: string): Promise<EventRow[]> => {
  const now = Date.now();
  for (const [key, entry] of eventReads) if (now - entry.at >= EVENTS_SHARED_MS) eventReads.delete(key);
  const key = `${fromIso}|${toIso}`;
  const hit = eventReads.get(key);
  if (hit) return hit.read;
  const read = readAllPages<EventRow>((from, to) =>
    supabase
      .from('analytics_events')
      .select('event_name,session_id,ip_hash,page_path,device_type,destination,tour_title,source_page_url,metadata,created_at', { count: 'exact' })
      .or(NOT_DEV_URL_FILTER)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  ).then((rows) => rows.filter((e) => !isDevUrl(e.source_page_url)));
  eventReads.set(key, { at: now, read });
  read.catch(() => {
    if (eventReads.get(key)?.read === read) eventReads.delete(key);
  });
  return read;
};

/** readEvents, fail-silent: an unreadable range reads as empty. */
const fetchEvents = async (fromIso: string, toIso: string): Promise<EventRow[]> => {
  try {
    return await readEvents(fromIso, toIso);
  } catch {
    return [];
  }
};

/** Live (not deleted) bookings created in range. Throws on a failed read. */
const readBookings = (fromIso: string, toIso: string): Promise<BookingRow[]> =>
  readAllPages<BookingRow>((from, to) =>
    supabase
      .from('booking_requests')
      .select('id,source,status,tour_id,lead_context,created_at', { count: 'exact' })
      .is('deleted_at', null)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );

const fetchBookings = async (fromIso: string, toIso: string): Promise<BookingRow[]> => {
  try {
    return await readBookings(fromIso, toIso);
  } catch {
    return [];
  }
};

// ── what each in-house figure counts ─────────────────────────────────────────
const PAGE_VIEW = 'page_view';
/** A form came into view or was opened: today's form_opened, and the older per-form names. */
const FORM_OPEN_EVENTS = new Set(['form_opened', 'plan_my_trip_opened', 'request_trip_opened', 'begin_journey_opened']);
/**
 * Interactions are things a visitor did: clicks, a search or filter, starting,
 * stepping through or sending a form, opening or writing to the AI advisor.
 * Page, tour, destination, style, stay and list views are not interactions,
 * nor is a form appearing (FORM_OPEN_EVENTS), nor what follows an action
 * rather than being one (no results, a validation error, an abandon, a failed send).
 */
const ACTION_EVENTS = new Set([
  'tour_card_click', 'related_tour_click', 'cta_click', 'whatsapp_click', 'phone_click', 'email_click',
  'tour_filter_used', 'search', 'quotation_download',
  'form_started', 'form_step_completed', 'form_submitted',
  'plan_my_trip_submitted', 'request_trip_submitted', 'begin_journey_submitted',
  'ai_advisor_opened', 'ai_advisor_message_sent'
]);
/** Bookings that did not come through the website (staff, imports, the WhatsApp inbox). */
const NON_WEBSITE_SOURCES = new Set(['admin_created', 'hubspot_import', 'whatsapp']);
/** The website's enquiry forms, by the source each one stores. */
const ENQUIRY_FORM_SOURCES = new Set(['plan_my_trip', 'website_booking_form', 'homepage_trip_planner', 'category_enquiry', 'tour_enquiry']);

const isEnquiryForm = (b: BookingRow) => ENQUIRY_FORM_SOURCES.has(b.source ?? '');
/** A WhatsApp tap by a visitor — staff in the CMS are not leads (old rows might carry them). */
const isWhatsappTap = (e: { event_name: string; page_path: string | null }) =>
  e.event_name === 'whatsapp_click' && !barePath(e.page_path).startsWith('/admin');

/** The website's leads in a set of bookings: website sources only, development tests left out. */
const websiteLeads = async (rows: BookingRow[]): Promise<{ rows: BookingRow[]; excludedDev: number }> => {
  const website = rows.filter((b) => !NON_WEBSITE_SOURCES.has(b.source ?? ''));
  const isDev = await devBookingTest(website);
  const kept = website.filter((b) => !isDev(b));
  return { rows: kept, excludedDev: website.length - kept.length };
};

/**
 * When each kind of in-house data starts: the first event, the first page view
 * (the tracker sent none before August 2026) and the first website lead still
 * in Bookings. A previous period from before these has nothing to compare.
 * null: not known (no data, or the read failed). Shared for ten minutes.
 */
export type DataStarts = { firstEventAt: string | null; firstPageViewAt: string | null; firstLeadAt: string | null };
let dataStarts: { at: number; read: Promise<DataStarts> } | null = null;

const firstAt = async (query: () => PromiseLike<{ data: unknown[] | null; error: unknown }>): Promise<string | null> => {
  try {
    const { data, error } = await query();
    if (error) return null;
    return (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
  } catch {
    return null;
  }
};

export const getDataStarts = (): Promise<DataStarts> => {
  if (dataStarts && Date.now() - dataStarts.at < 10 * 60_000) return dataStarts.read;
  const events = () =>
    supabase.from('analytics_events').select('created_at').or(NOT_DEV_URL_FILTER).order('created_at', { ascending: true }).limit(1);
  const read = Promise.all([
    firstAt(events),
    firstAt(() => events().eq('event_name', PAGE_VIEW)),
    firstAt(() =>
      supabase
        .from('booking_requests')
        .select('created_at')
        .is('deleted_at', null)
        .or(`source.is.null,source.not.in.(${[...NON_WEBSITE_SOURCES].join(',')})`)
        .order('created_at', { ascending: true })
        .limit(1)
    )
  ]).then(([firstEventAt, firstPageViewAt, firstLeadAt]) => {
    // Only a complete answer is kept; a gap is asked again next time.
    if ((!firstEventAt || !firstPageViewAt || !firstLeadAt) && dataStarts?.read === read) dataStarts = null;
    return { firstEventAt, firstPageViewAt, firstLeadAt };
  });
  dataStarts = { at: Date.now(), read };
  return read;
};

// ── status mapping: existing booking statuses → lead funnel stages ───────────
const isContacted = (s: string | null) =>
  ['contacted', 'itinerary_sent', 'negotiating', 'confirmed', 'completed'].includes(s ?? '');
const isQuoted = (s: string | null) =>
  ['itinerary_sent', 'negotiating', 'confirmed', 'completed'].includes(s ?? '');
const isBooked = (s: string | null) => ['confirmed', 'completed'].includes(s ?? '');

const lc = (b: BookingRow, key: string): string => {
  const v = (b.lead_context ?? {})[key];
  return typeof v === 'string' ? v.trim() : '';
};

const tally = (items: string[]): Array<{ label: string; value: number }> => {
  const map = new Map<string, number>();
  for (const item of items) {
    const key = item || 'Not specified';
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
};

/** A share in %, one decimal, never above 100 (0 when there is no base). */
const pct = (numerator: number, denominator: number) =>
  denominator > 0 ? Math.min(100, Math.round((numerator / denominator) * 1000) / 10) : 0;

// ── public aggregations ──────────────────────────────────────────────────────
/**
 * The in-house overview. Visitors are sessions with at least one page view;
 * automated networks (withoutAutomated) are out of every event figure, never
 * out of the leads. Leads are the website's enquiries in Bookings (staff,
 * imports and development tests left out). `ok` is false when a read failed
 * and the figures are incomplete.
 */
export const getOverview = async (range: ResolvedRange) => {
  let ok = true;
  const [rawEvents, rawBookings] = await Promise.all([
    readEvents(range.fromIso, range.toIso).catch((): EventRow[] => {
      ok = false;
      return [];
    }),
    readBookings(range.fromIso, range.toIso).catch((): BookingRow[] => {
      ok = false;
      return [];
    })
  ]);
  const { rows: events, excludedSessions } = withoutAutomated(rawEvents);
  const { rows: leads } = await websiteLeads(rawBookings);

  const named = (name: string) => events.filter((e) => e.event_name === name);
  const pageViews = named(PAGE_VIEW);
  const visitors = sessionsOf(pageViews).size;
  const actions = events.filter((e) => ACTION_EVENTS.has(e.event_name));
  const opened = sessionsOf(events.filter((e) => FORM_OPEN_EVENTS.has(e.event_name)));

  const enquiries = leads.filter(isEnquiryForm);
  // Emnel's bookings carry no session id; the submit events do, so a session
  // that sent an enquiry is known from either.
  const enquirySessions = union(
    new Set(enquiries.map(bookingSession).filter(Boolean)),
    sessionsOf(events.filter((e) => SUBMIT_EVENTS.has(e.event_name)))
  );
  // Measured inside one population: of the sessions seen opening a form, how
  // many sent an enquiry. Enquiries also come from visitors who declined
  // analytics, who were never seen opening anything.
  const openedAndSent = [...opened].filter((sid) => enquirySessions.has(sid)).length;
  const itineraryRequests = leads.filter((b) => bookingChannel(b) === 'itinerary_form').length;

  return {
    ok,
    visitors,
    pageViews: pageViews.length,
    interactions: actions.length,
    /** Visitors who did at least one interaction (sessions with a page view only). */
    activeVisitors: [...sessionsOf(actions)].filter((sid) => sessionsOf(pageViews).has(sid)).length,
    planMyTripSubmissions: leads.filter((b) => b.source === 'plan_my_trip').length,
    requestTripSubmissions: itineraryRequests,
    aiLeads: leads.filter((b) => b.source === 'ai_handoff').length,
    whatsappClicks: events.filter(isWhatsappTap).length,
    phoneClicks: named('phone_click').length,
    emailClicks: named('email_click').length,
    aiAdvisorOpened: named('ai_advisor_opened').length,
    totalLeads: leads.length,
    /** Sessions that opened (or were shown) an enquiry form. */
    formOpens: opened.size,
    /** Enquiry-form bookings: Plan My Trip, the itinerary form and the enquiry forms. */
    formSubmissions: enquiries.length,
    /** Itinerary-form bookings (the tour-page request form). */
    itineraryRequests,
    /** Sessions that opened a form and sent an enquiry from it. */
    formOpenersWhoSent: openedAndSent,
    // Form conversion = form openers who sent an enquiry / form openers.
    formConversionRate: pct(openedAndSent, opened.size),
    // Lead conversion = website leads / visitors.
    leadConversionRate: pct(leads.length, visitors),
    /** Sessions left out as automated (withoutAutomated). */
    automatedExcluded: excludedSessions
  };
};

/**
 * The lead charts: the same leads the Leads card counts — the website's
 * enquiries, staff entries, imports and development tests left out — so a
 * chart and the card above it never disagree. Days with no lead read 0.
 */
export const getLeadAnalytics = async (range: ResolvedRange) => {
  let ok = true;
  const raw = await readBookings(range.fromIso, range.toIso).catch((): BookingRow[] => {
    ok = false;
    return [];
  });
  const { rows: bookings } = await websiteLeads(raw);

  const leadsByDay = perDay(daysOf(range), bookings.map((b) => b.created_at));

  const sourceLabels: Record<string, string> = {
    website_booking_form: 'Request This Trip',
    plan_my_trip: 'Plan My Trip',
    homepage_trip_planner: 'Home page enquiry',
    category_enquiry: 'Style page enquiry',
    tour_enquiry: 'Tour enquiry',
    ai_handoff: 'Chat advisor (retired)'
  };

  // experience interests are stored joined ("Safari, Beach") — split them out
  const experiences: string[] = [];
  for (const b of bookings) {
    const raw = lc(b, 'travel_interests') || lc(b, 'experience_interests');
    if (raw) raw.split(',').forEach((part) => experiences.push(part.trim()));
  }

  return {
    ok,
    total: bookings.length,
    leadsByDay,
    bySource: tally(bookings.map((b) => sourceLabels[b.source ?? ''] ?? b.source ?? 'Unknown')),
    byDestination: tally(bookings.map((b) => lc(b, 'destination_interest') || lc(b, 'selected_trip'))),
    byBudget: tally(bookings.map((b) => lc(b, 'budget_range') || lc(b, 'budget_per_person'))),
    byExperience: tally(experiences),
    byTravellerType: tally(bookings.map((b) => lc(b, 'traveller_type'))),
    byAccommodation: tally(bookings.map((b) => lc(b, 'accommodation_preference'))),
    byStatus: tally(bookings.map((b) => b.status ?? 'pending'))
  };
};

/**
 * The website funnel, in distinct visitors at every stage: visitors → viewed a
 * tour → opened an enquiry form → sent an enquiry → contacted → quoted →
 * booked. The first three are in-house sessions (automated networks out); the
 * rest are the website's enquiry-form bookings and their status in Bookings.
 * The stages are not nested — the home page shows a form to people who never
 * open a tour, and enquiries also come from visitors who declined analytics —
 * so a drop is only measured where the later stage is no larger than the
 * earlier one; any other pair is not comparable. Rates never exceed 100.
 */
export const getFunnel = async (range: ResolvedRange) => {
  let ok = true;
  const failed = <T>(): T[] => {
    ok = false;
    return [];
  };
  const [rawEvents, rawBookings] = await Promise.all([
    readEvents(range.fromIso, range.toIso).catch(() => failed<EventRow>()),
    readBookings(range.fromIso, range.toIso).catch(() => failed<BookingRow>())
  ]);
  const { rows: events } = withoutAutomated(rawEvents);
  const enquiries = (await websiteLeads(rawBookings)).rows.filter(isEnquiryForm);
  const sessionsWith = (match: (name: string) => boolean) => sessionsOf(events.filter((e) => match(e.event_name))).size;

  const visitors = sessionsWith((name) => name === PAGE_VIEW);
  const tourViewers = sessionsWith((name) => name === 'tour_page_view');
  const formOpeners = sessionsWith((name) => FORM_OPEN_EVENTS.has(name));
  const sent = enquiries.length;
  const contacted = enquiries.filter((b) => isContacted(b.status)).length;
  const quoted = enquiries.filter((b) => isQuoted(b.status)).length;
  const booked = enquiries.filter((b) => isBooked(b.status)).length;

  const stages = [
    { key: 'visitor', label: 'Visitors', value: visitors },
    { key: 'tour_view', label: 'Viewed a tour', value: tourViewers },
    { key: 'form_open', label: 'Opened an enquiry form', value: formOpeners },
    { key: 'submitted', label: 'Sent an enquiry', value: sent },
    { key: 'contacted', label: 'Contacted', value: contacted },
    { key: 'quoted', label: 'Quoted', value: quoted },
    { key: 'booked', label: 'Booked', value: booked }
  ];
  const drops = stages.slice(1).map((to, i) => {
    const from = stages[i];
    const comparable = from.value > 0 && to.value <= from.value;
    return {
      from: from.key, fromLabel: from.label, fromValue: from.value,
      to: to.key, toLabel: to.label, toValue: to.value,
      comparable,
      dropPct: comparable ? round1(((from.value - to.value) / from.value) * 100) : null
    };
  });

  // The one biggest drop, by one rule for every screen: comparable stages, a
  // base of 10 or more, and — while the range is still under 90% through — no
  // drop into the stages that lag the visit (enquiries arrive later, replies later still).
  const elapsed = Date.now() >= Date.parse(range.toIso) ? 1 : Math.max(0, (Date.now() - Date.parse(range.fromIso)) / (Date.parse(range.toIso) - Date.parse(range.fromIso)));
  const LAGGING = new Set(['submitted', 'contacted', 'quoted', 'booked']);
  let biggestDrop: (typeof drops)[number] | null = null;
  for (const d of drops) {
    if (!d.comparable || d.dropPct === null || d.dropPct <= 0 || d.fromValue < 10) continue;
    if (elapsed < 0.9 && LAGGING.has(d.to)) continue;
    if (!biggestDrop || d.dropPct > (biggestDrop.dropPct ?? 0)) biggestDrop = d;
  }

  return {
    ok,
    stages,
    drops,
    biggestDrop,
    rates: {
      visitorsToTourView: pct(tourViewers, visitors),
      visitorsToFormOpen: pct(formOpeners, visitors),
      formOpenToSubmit: pct(sent, formOpeners),
      submitToContacted: pct(contacted, sent),
      contactedToBooked: pct(booked, contacted)
    }
  };
};

export const getEventTimeseries = async (range: ResolvedRange) => {
  let ok = true;
  const raw = await readEvents(range.fromIso, range.toIso).catch((): EventRow[] => {
    ok = false;
    return [];
  });
  const { rows: events } = withoutAutomated(raw);

  // Per day: visitors (sessions with a page view), page views, interactions,
  // WhatsApp taps, AI advisor events and every event — automated networks out.
  type Bucket = { sessions: Set<string>; pageViews: number; interactions: number; whatsapp: number; ai: number; events: number };
  const days = new Map<string, Bucket>();
  for (const e of events) {
    const d = dayKey(e.created_at);
    const bucket = days.get(d) ?? { sessions: new Set<string>(), pageViews: 0, interactions: 0, whatsapp: 0, ai: 0, events: 0 };
    if (e.event_name === PAGE_VIEW) {
      bucket.pageViews += 1;
      if (e.session_id) bucket.sessions.add(e.session_id);
    }
    if (ACTION_EVENTS.has(e.event_name)) bucket.interactions += 1;
    if (isWhatsappTap(e)) bucket.whatsapp += 1;
    if (e.event_name.startsWith('ai_advisor')) bucket.ai += 1;
    bucket.events += 1;
    days.set(d, bucket);
  }

  const deviceTally = tally(events.map((e) => e.device_type ?? 'unknown'));

  return {
    ok,
    // Every day of the range, quiet ones as 0, so a trend's halves split by date.
    byDay: daysOf(range).map((date) => {
      const b = days.get(date);
      return {
        date, visitors: b?.sessions.size ?? 0, pageViews: b?.pageViews ?? 0, interactions: b?.interactions ?? 0,
        whatsapp: b?.whatsapp ?? 0, ai: b?.ai ?? 0, events: b?.events ?? 0
      };
    }),
    byDevice: deviceTally,
    topEvents: tally(events.map((e) => e.event_name))
  };
};

// ── Main leads ───────────────────────────────────────────────────────────────
// The three leads the business runs on: the Plan My Trip planner, the itinerary
// form on tour pages, and WhatsApp. A form lead is a booking_requests row (the
// real record, whatever the visitor's consent); the path to it — opened, steps,
// errors, abandons — and every WhatsApp tap come from the in-house events,
// which carry form_name / step / CTA context in metadata since recordEvent
// started keeping it. Older rows carry less; formChannel reads them the best
// truthful way rather than dropping them. Development rows never count.

export type LeadChannel = 'plan_my_trip' | 'itinerary_form' | 'whatsapp';
type FormChannel = Exclude<LeadChannel, 'whatsapp'>;
type Tally = Array<{ label: string; value: number }>;

export type MainLeads = {
  /** false: a read failed and this is the empty shape — no figure here is known. */
  ok: boolean;
  range: { from: string; to: string; days: number };
  channels: Array<{
    key: LeadChannel;
    label: string;
    leads: number;
    uniqueVisitors: number;
    previous: number;
    changePct: number | null;
    trackedEvents: number;
    opened: number | null;
    conversionRate: number | null;
    byDay: Array<{ date: string; value: number }>;
  }>;
  planner: {
    /** The site sent step events for the planner in this range (form_started / form_step_completed). */
    stepsTracked: boolean;
    steps: Array<{ index: number; key: string; label: string; reached: number; completed: number; dropOffPct: number }>;
    validationErrors: Tally;
    abandonedAt: Tally;
    submitErrors: number;
    byTripType: Tally;
    byStage: Tally;
    byComfort: Tally;
    byBudget: Tally;
  };
  itinerary: {
    /**
     * The site sent step events for the itinerary form in this range. Without
     * them the funnel is only Form seen → Request sent: a "Started" stage of 0
     * would read as everyone leaving at the first question.
     */
    stepsTracked: boolean;
    funnel: Array<{ key: 'opened' | 'started' | 'details' | 'submitted'; label: string; value: number }>;
    topTours: Tally;
    submitErrors: number;
  };
  whatsapp: { byLocation: Tally; byPage: Tally; byTour: Tally; byDevice: Tally };
  sources: Array<{ label: string; planner: number; itinerary: number; whatsapp: number; total: number }>;
  /** Some lead in range carries a recorded referrer/UTM; false means "Direct / unknown" is a recording gap. */
  sourcesTracked: boolean;
  tracking: {
    ga4: { configured: boolean; events: Array<{ name: string; count: number }> | null };
    clarity: { configured: boolean; projectId: string | null };
    inHouse: { eventsInRange: number; lastEventAt: string | null; excludedDevEvents: number; excludedDevLeads: number };
    reconciliation: Array<{ channel: LeadChannel; label: string; database: number | null; inHouse: number; ga4: number | null }>;
  };
};

const CHANNEL_LABELS: Record<LeadChannel, string> = {
  plan_my_trip: 'Plan My Trip',
  itinerary_form: 'Itinerary form',
  whatsapp: 'WhatsApp'
};

const PLANNER_FORM = 'plan_my_trip';
const ITINERARY_FORMS = new Set(['tour_itinerary', 'tour_booking_page']);

// The planner's seven steps, in order — the same keys the page sends as step_key.
const PLANNER_STEPS = [
  { key: 'trip_type', label: 'Trip type' },
  { key: 'travellers', label: 'Travellers' },
  { key: 'when', label: 'When' },
  { key: 'length_pace', label: 'Length & pace' },
  { key: 'preferences', label: 'Preferences' },
  { key: 'planning_stage', label: 'Planning stage' },
  { key: 'summary', label: 'Summary' }
];

// Every event name the main-lead report reads (current and pre-form_name ones).
const LEAD_EVENT_NAMES = [
  'form_opened', 'form_started', 'form_step_completed', 'form_validation_error', 'form_abandoned',
  'form_submit_error', 'form_submitted', 'plan_my_trip_opened', 'plan_my_trip_submitted',
  'request_trip_opened', 'request_trip_submitted', 'whatsapp_click'
];
const SUBMIT_EVENTS = new Set(['plan_my_trip_submitted', 'request_trip_submitted', 'form_submitted']);

type LeadEventRow = EventRow;

type SessionSourceRow = { session_id: string; utm_source: string | null; utm_medium: string | null; referrer: string | null };

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
const metaText = (e: LeadEventRow, key: string): string => text(obj(e.metadata)[key]);
const metaNumber = (e: LeadEventRow, key: string): number | null => {
  const raw = obj(e.metadata)[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
};
const round1 = (n: number) => Math.round(n * 10) / 10;
/** The path without a language prefix: /fr/tours/x → /tours/x. */
const barePath = (path: string | null) => (path ?? '').replace(/^\/[a-z]{2}(?=\/)/, '');

/**
 * Which main-lead form an event belongs to (null: another form, or none).
 * form_name decides when the row has one. Rows from before it was stored are
 * read by their event name, the legacy metadata.form the pages used to send
 * ('trip_planner' was the planner, 'trip_request' the itinerary form,
 * 'style_planner' neither), and finally the page they were sent from.
 */
const formChannel = (e: LeadEventRow): FormChannel | null => {
  const name = metaText(e, 'form_name');
  if (name === PLANNER_FORM) return 'plan_my_trip';
  if (ITINERARY_FORMS.has(name)) return 'itinerary_form';
  if (name) return null;
  const lead = metaText(e, 'lead_type');
  if (lead === 'plan_my_trip' || lead === 'itinerary_form') return lead;

  switch (e.event_name) {
    case 'plan_my_trip_opened':
    case 'plan_my_trip_submitted':
      return 'plan_my_trip';
    case 'request_trip_opened':
    case 'request_trip_submitted': {
      // The page decides first: from 6 to 30 Sept 2026 /plan-my-trip rendered
      // the itinerary form itself (form 'trip_request'), and those were planner leads.
      const path = barePath(e.page_path);
      if (path.startsWith('/plan-my-trip')) return 'plan_my_trip';
      const form = metaText(e, 'form');
      if (form === 'trip_planner') return 'plan_my_trip';
      if (path.startsWith('/tours/') || path.startsWith('/booking/')) return 'itinerary_form';
      if (form === 'trip_request') return 'itinerary_form';
      return null;
    }
    default:
      return null;
  }
};

/**
 * One lead per session per form within two minutes: a double tap, or an old
 * and a new lead event for the same send, counts once. Rows without a session
 * cannot be matched and each count.
 */
const dedupeSubmits = (rows: LeadEventRow[]): LeadEventRow[] => {
  const lastAt = new Map<string, number>();
  const out: LeadEventRow[] = [];
  for (const e of [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const sid = e.session_id ?? '';
    const at = Date.parse(e.created_at);
    if (sid) {
      const prev = lastAt.get(sid);
      if (prev !== undefined && at - prev < 120_000) continue;
      lastAt.set(sid, at);
    }
    out.push(e);
  }
  return out;
};

const bookingContext = (b: BookingRow) => obj(b.lead_context);

/** A booking's main-lead channel (null: AI, admin, enquiry forms…). */
const bookingChannel = (b: BookingRow): FormChannel | null => {
  if (b.source === 'plan_my_trip') return 'plan_my_trip';
  if (b.source === 'website_booking_form' || ITINERARY_FORMS.has(text(bookingContext(b).form_name))) return 'itinerary_form';
  return null;
};

const bookingSession = (b: BookingRow): string => text(obj(bookingContext(b).attribution).session_id);

/** An answer from the nested answers block, or the flat key the older planner wrote. */
const bookingAnswer = (b: BookingRow, key: string): unknown => {
  const ctx = bookingContext(b);
  const nested = obj(ctx.answers)[key];
  return nested !== undefined && nested !== null && nested !== '' ? nested : ctx[key];
};

/** Multi-choice answers arrive as arrays (new planner) or "A, B" strings (old). */
const answerList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : typeof value === 'string'
      ? value.split(',').map((part) => part.trim()).filter(Boolean)
      : [];

/** Where a referrer host belongs, in the words the owner uses. */
const referrerLabel = (referrer: string): string | null => {
  let host = '';
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  if (/(^|\.)google\.[a-z.]+$/.test(host) || host === 'com.google.android.googlequicksearchbox') return 'Google (organic)';
  if (/(^|\.)(bing\.com|duckduckgo\.com|yahoo\.[a-z.]+)$/.test(host)) return 'Other search';
  if (/(^|\.)(facebook\.com|instagram\.com|t\.co|x\.com|twitter\.com|linkedin\.com|lnkd\.in|tiktok\.com)$/.test(host)) return 'Social';
  if (/(^|\.)tripadvisor\.[a-z.]+$/.test(host)) return 'TripAdvisor';
  return host;
};

const sourceLabel = (s: { gclid?: string; utmSource?: string; utmMedium?: string; referrer?: string }): string => {
  if (s.gclid) return 'Google Ads';
  // The session beacon records an auto-tagged ad click as google / cpc.
  if (/^google$/i.test(s.utmSource ?? '') && /^(cpc|ppc|paid)/i.test(s.utmMedium ?? '')) return 'Google Ads';
  if (s.utmSource) return s.utmMedium ? `${s.utmSource} / ${s.utmMedium}` : s.utmSource;
  const fromReferrer = s.referrer ? referrerLabel(s.referrer) : null;
  return fromReferrer ?? 'Direct / unknown';
};

/** First-touch source of a form lead: stored attribution first, then this visit's campaign tags. */
const bookingSource = (b: BookingRow): string => {
  const ctx = bookingContext(b);
  const attribution = obj(ctx.attribution);
  const campaign = obj(ctx.campaign);
  const utm = obj(ctx.utm);
  const tagged = [attribution, campaign, utm].find((block) => text(block.utm_source)) ?? {};
  return sourceLabel({
    gclid: text(campaign.gclid) || text(attribution.gclid) || text(utm.gclid),
    utmSource: text(tagged.utm_source),
    utmMedium: text(tagged.utm_medium),
    referrer: text(attribution.referrer)
  });
};

const daysOf = (range: ResolvedRange): string[] => {
  const out: string[] = [];
  const end = Date.parse(range.toIso);
  for (let t = Date.parse(range.fromIso); t < end && out.length < 1000; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

const perDay = (days: string[], createdAt: string[]): Array<{ date: string; value: number }> => {
  const counts = new Map<string, number>();
  for (const at of createdAt) counts.set(dayKey(at), (counts.get(dayKey(at)) ?? 0) + 1);
  return days.map((date) => ({ date, value: counts.get(date) ?? 0 }));
};

const sessionsOf = (rows: Array<{ session_id: string | null }>): Set<string> =>
  new Set(rows.map((e) => e.session_id).filter((sid): sid is string => Boolean(sid)));

const union = (...sets: Set<string>[]): Set<string> => new Set(sets.flatMap((set) => [...set]));

/** Did the site report the form step by step (not only opened and sent)? */
const hasStepEvents = (rows: Array<{ event_name: string }>): boolean =>
  rows.some((e) => e.event_name === 'form_started' || e.event_name === 'form_step_completed');

// ── main-lead fetchers ───────────────────────────────────────────────────────
/** Events in range: everything received, and how much of it came from development. Throws on a failed read. */
const countEvents = async (range: ResolvedRange): Promise<{ total: number; dev: number }> => {
  const all = () =>
    supabase
      .from('analytics_events')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', range.fromIso)
      .lt('created_at', range.toIso);
  const [total, dev] = await Promise.all([all(), all().or(DEV_URL_FILTER)]);
  if (total.error || dev.error) throw new Error((total.error ?? dev.error)?.message ?? 'count failed');
  return { total: total.count ?? 0, dev: dev.count ?? 0 };
};

/** When the in-house tracker last heard from a real visitor (any date). */
const fetchLastEventAt = async (): Promise<string | null> => {
  try {
    const { data } = await supabase
      .from('analytics_events')
      .select('created_at')
      .or(NOT_DEV_URL_FILTER)
      .order('created_at', { ascending: false })
      .limit(1);
    return (data?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
  } catch {
    return null;
  }
};

/**
 * Sessions that ever sent an event from a development host. The session id
 * lives in the browser's storage for one origin only, so a lead carrying one of
 * these was sent from a developer's local site — a test, not a traveller.
 */
const fetchDevSessions = async (sessionIds: string[]): Promise<Set<string>> => {
  const out = new Set<string>();
  for (const ids of chunk([...new Set(sessionIds)], 200)) {
    try {
      const rows = await readAllPages<{ session_id: string | null }>((from, to) =>
        supabase
          .from('analytics_events')
          .select('session_id', { count: 'exact' })
          .in('session_id', ids)
          .or(DEV_URL_FILTER)
          .order('id', { ascending: true })
          .range(from, to)
      );
      for (const row of rows) if (row.session_id) out.add(row.session_id);
    } catch {
      // unknown → treat as real
    }
  }
  return out;
};

/**
 * First-touch source of a WhatsApp tap. Emnel records no per-visit campaign or
 * referrer data, so every tap reads as "Direct / unknown" rather than a guess.
 */
const fetchSessionSources = async (_sessionIds: string[]): Promise<Map<string, SessionSourceRow>> => new Map();

/** Lead bookings staff deleted (tests, spam) — their submit events are not leads either. Throws on a failed read. */
const readDeletedBookings = (fromIso: string, toIso: string): Promise<BookingRow[]> =>
  readAllPages<BookingRow>((from, to) =>
    supabase
      .from('booking_requests')
      .select('id,source,status,tour_id,lead_context,created_at', { count: 'exact' })
      .not('deleted_at', 'is', null)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  );

/**
 * A test for bookings sent from a development site (a test, not a traveller):
 * the page they were sent from, or a session that ever sent an event from a
 * development host. The session read is fail-silent (unknown reads as real).
 */
const devBookingTest = async (rows: BookingRow[]): Promise<(b: BookingRow) => boolean> => {
  const devSessions = await fetchDevSessions(rows.map(bookingSession).filter(Boolean));
  return (b: BookingRow) => {
    const ctx = bookingContext(b);
    const pageUrl = text(obj(ctx.page).url) || text(ctx.source_page_url);
    return isDevUrl(pageUrl) || devSessions.has(bookingSession(b));
  };
};

const fetchTourTitles = async (tourIds: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for (const ids of chunk([...new Set(tourIds)], 200)) {
    try {
      const { data } = await supabase.from('tours').select('id,title').in('id', ids);
      for (const row of (data ?? []) as Array<{ id: string; title: string | null }>) if (row.title) out.set(row.id, row.title);
    } catch {
      // falls back to 'Unknown tour'
    }
  }
  return out;
};

/** The shape when a read failed: ok false, every figure zero (unknown, not none). */
const emptyMainLeads = (range: ResolvedRange): MainLeads => {
  const days = daysOf(range);
  const zeroDays = days.map((date) => ({ date, value: 0 }));
  return {
    ok: false,
    range: { from: range.fromIso, to: range.toIso, days: range.days },
    channels: (Object.keys(CHANNEL_LABELS) as LeadChannel[]).map((key) => ({
      key, label: CHANNEL_LABELS[key], leads: 0, uniqueVisitors: 0, previous: 0, changePct: null,
      trackedEvents: 0, opened: key === 'whatsapp' ? null : 0, conversionRate: null, byDay: zeroDays
    })),
    planner: {
      stepsTracked: false,
      steps: PLANNER_STEPS.map((s, index) => ({ index, key: s.key, label: s.label, reached: 0, completed: 0, dropOffPct: 0 })),
      validationErrors: [], abandonedAt: [], submitErrors: 0, byTripType: [], byStage: [], byComfort: [], byBudget: []
    },
    itinerary: {
      stepsTracked: false,
      funnel: [
        { key: 'opened', label: 'Form seen', value: 0 },
        { key: 'submitted', label: 'Request sent', value: 0 }
      ],
      topTours: [],
      submitErrors: 0
    },
    whatsapp: { byLocation: [], byPage: [], byTour: [], byDevice: [] },
    sources: [],
    sourcesTracked: false,
    tracking: {
      ga4: { configured: isGa4Configured(), events: null },
      clarity: { configured: isClarityConfigured(), projectId: env.CLARITY_PROJECT_ID || null },
      inHouse: { eventsInRange: 0, lastEventAt: null, excludedDevEvents: 0, excludedDevLeads: 0 },
      reconciliation: (Object.keys(CHANNEL_LABELS) as LeadChannel[]).map((channel) => ({
        channel, label: CHANNEL_LABELS[channel], database: channel === 'whatsapp' ? null : 0, inHouse: 0, ga4: null
      }))
    }
  };
};

// /main-leads and /website-intelligence (through the interpretation) ask for
// the same range together, so one report is shared for a minute — the read in
// flight included. A failed report (ok false) is never kept.
const MAIN_LEADS_SHARED_MS = 60_000;
const mainLeadsReads = new Map<string, { at: number; read: Promise<MainLeads> }>();

/**
 * The CMS's main-leads report. Fail-silent: when any of its core reads fails
 * it returns the empty shape with ok false, never a half-counted report.
 */
export const getMainLeads = (range: ResolvedRange): Promise<MainLeads> => {
  const now = Date.now();
  for (const [key, entry] of mainLeadsReads) if (now - entry.at >= MAIN_LEADS_SHARED_MS) mainLeadsReads.delete(key);
  const key = `${range.fromIso}:${range.toIso}`;
  const hit = mainLeadsReads.get(key);
  if (hit) return hit.read;
  const read: Promise<MainLeads> = buildMainLeads(range).then((report) => {
    if (!report.ok && mainLeadsReads.get(key)?.read === read) mainLeadsReads.delete(key);
    return report;
  });
  mainLeadsReads.set(key, { at: now, read });
  return read;
};

const buildMainLeads = async (range: ResolvedRange): Promise<MainLeads> => {
  try {
    // The previous period: the same length, immediately before this one.
    const spanMs = Date.parse(range.toIso) - Date.parse(range.fromIso);
    const prevFromIso = new Date(Date.parse(range.fromIso) - spanMs).toISOString();
    const prevToIso = range.fromIso;

    // Every event of both periods (whole UTC days), so the automated-traffic
    // rule sees each network's full session count; the lead events are picked
    // from them below. Any core read failing throws to the empty shape.
    const [allEvents, allPrevEvents, rawBookings, rawPrevBookings, counts, lastEventAt, ga4, deletedBookings] = await Promise.all([
      readEvents(range.fromIso, range.toIso),
      readEvents(prevFromIso, prevToIso),
      readBookings(range.fromIso, range.toIso),
      readBookings(prevFromIso, prevToIso),
      countEvents(range),
      fetchLastEventAt(),
      getGa4LeadEvents(range),
      readDeletedBookings(range.fromIso, range.toIso)
    ]);

    // ── development and automated traffic out of every figure (bookings are never automated) ──
    const leadEventNames = new Set(LEAD_EVENT_NAMES);
    const events = withoutAutomated(allEvents).rows.filter((e) => leadEventNames.has(e.event_name));
    const isLeadBooking = (b: BookingRow) => bookingChannel(b) !== null;
    const leadBookingsAll = rawBookings.filter(isLeadBooking);
    const prevLeadBookingsAll = rawPrevBookings.filter(isLeadBooking);
    const isDevBooking = await devBookingTest([...leadBookingsAll, ...prevLeadBookingsAll]);
    const leadBookings = leadBookingsAll.filter((b) => !isDevBooking(b));
    const prevLeadBookings = prevLeadBookingsAll.filter((b) => !isDevBooking(b));
    const excludedDevLeads = leadBookingsAll.length - leadBookings.length;

    const whatsappClicks = events.filter(isWhatsappTap);
    const prevWhatsappClicks = withoutAutomated(allPrevEvents).rows.filter(isWhatsappTap);

    const plannerEvents = events.filter((e) => formChannel(e) === 'plan_my_trip');
    const itineraryEvents = events.filter((e) => formChannel(e) === 'itinerary_form');
    const plannerBookings = leadBookings.filter((b) => bookingChannel(b) === 'plan_my_trip');
    const itineraryBookings = leadBookings.filter((b) => bookingChannel(b) === 'itinerary_form');

    // A submit whose booking staff deleted (a test, spam) is no lead: same
    // session, within five minutes of the deleted booking.
    const deletedAt = new Map<string, number[]>();
    for (const b of deletedBookings) {
      const sid = bookingSession(b);
      if (sid && bookingChannel(b)) deletedAt.set(sid, [...(deletedAt.get(sid) ?? []), Date.parse(b.created_at)]);
    }
    const ofDeletedBooking = (e: LeadEventRow) =>
      Boolean(e.session_id) && (deletedAt.get(e.session_id as string) ?? []).some((t) => Math.abs(t - Date.parse(e.created_at)) < 300_000);
    const realSubmits = (rows: LeadEventRow[]) => dedupeSubmits(rows.filter((e) => SUBMIT_EVENTS.has(e.event_name) && !ofDeletedBooking(e)));
    const plannerSubmits = realSubmits(plannerEvents);
    const itinerarySubmits = realSubmits(itineraryEvents);

    // Opened: the form was seen. Anyone who got further surely saw it too, so
    // they count even when their open event is missing (an old row, a reload).
    const openedSessions = (rows: LeadEventRow[], legacyOpen: string) =>
      union(
        sessionsOf(rows.filter((e) => e.event_name === 'form_opened' || e.event_name === legacyOpen)),
        sessionsOf(rows.filter((e) => e.event_name === 'form_started' || e.event_name === 'form_step_completed'))
      );
    // Sessions that sent the lead: the submit events, and the bookings' own session ids.
    const leadSessionsOf = (submits: LeadEventRow[], bookings: BookingRow[]) =>
      union(sessionsOf(submits), new Set(bookings.map(bookingSession).filter(Boolean)));
    const plannerLeadSessions = leadSessionsOf(plannerSubmits, leadBookings.filter((b) => bookingChannel(b) === 'plan_my_trip'));
    const itineraryLeadSessions = leadSessionsOf(itinerarySubmits, leadBookings.filter((b) => bookingChannel(b) === 'itinerary_form'));
    const plannerOpened = openedSessions(plannerEvents, 'plan_my_trip_opened');
    const itineraryOpened = openedSessions(itineraryEvents, 'request_trip_opened');
    const intersect = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));
    // Conversion and the itinerary funnel use the sessions the site's form
    // tracker followed. Emnel's forms send their own per-form events
    // (plan_my_trip_opened / _submitted, request_trip_opened) without a
    // form_name tag, and those open and submit sessions line up, so every
    // form row counts; a form_name tag, when present, is honoured as well.
    const tagged = (rows: LeadEventRow[]) => rows;
    const plannerTracked = openedSessions(tagged(plannerEvents), 'plan_my_trip_opened');
    const itineraryTrackedEvents = tagged(itineraryEvents);
    const itineraryTracked = openedSessions(itineraryTrackedEvents, 'request_trip_opened');

    // ── channels ──
    const days = daysOf(range);
    // No % on a base under 5 ("8, up from 1" is not +700%), and none while the
    // range is still well short of over (today's few hours against a whole day).
    const rangeElapsed = Date.now() >= Date.parse(range.toIso) ? 1 : Math.max(0, (Date.now() - Date.parse(range.fromIso)) / (Date.parse(range.toIso) - Date.parse(range.fromIso)));
    const change = (now: number, before: number) =>
      before >= 5 && rangeElapsed >= 0.9 ? round1(((now - before) / before) * 100) : null;
    /**
     * Conversion is measured inside one population: of the sessions the tracker
     * saw open the form, how many sent it. Saved leads also include visitors who
     * declined analytics (never seen opening) and leads from before the tracker
     * — dividing those by tracked opens once read 700%.
     */
    const rate = (opened: Set<string>, leadSessions: Set<string>) =>
      opened.size > 0 ? round1((intersect(opened, leadSessions).size / opened.size) * 100) : null;
    // Emnel's bookings carry no session id, so the people behind the leads are
    // the distinct sessions of the submit events plus any booking session.
    const leadPeople = (submits: LeadEventRow[], rows: BookingRow[]) => leadSessionsOf(submits, rows).size;
    const prevCount = (channel: FormChannel) => prevLeadBookings.filter((b) => bookingChannel(b) === channel).length;

    const channels: MainLeads['channels'] = [
      {
        key: 'plan_my_trip',
        label: CHANNEL_LABELS.plan_my_trip,
        leads: plannerBookings.length,
        uniqueVisitors: leadPeople(plannerSubmits, plannerBookings),
        previous: prevCount('plan_my_trip'),
        changePct: change(plannerBookings.length, prevCount('plan_my_trip')),
        trackedEvents: plannerSubmits.length,
        opened: plannerOpened.size,
        conversionRate: rate(plannerTracked, plannerLeadSessions),
        byDay: perDay(days, plannerBookings.map((b) => b.created_at))
      },
      {
        key: 'itinerary_form',
        label: CHANNEL_LABELS.itinerary_form,
        leads: itineraryBookings.length,
        uniqueVisitors: leadPeople(itinerarySubmits, itineraryBookings),
        previous: prevCount('itinerary_form'),
        changePct: change(itineraryBookings.length, prevCount('itinerary_form')),
        trackedEvents: itinerarySubmits.length,
        opened: itineraryOpened.size,
        conversionRate: rate(itineraryTracked, itineraryLeadSessions),
        byDay: perDay(days, itineraryBookings.map((b) => b.created_at))
      },
      {
        key: 'whatsapp',
        label: CHANNEL_LABELS.whatsapp,
        leads: whatsappClicks.length,
        uniqueVisitors: sessionsOf(whatsappClicks).size,
        previous: prevWhatsappClicks.length,
        changePct: change(whatsappClicks.length, prevWhatsappClicks.length),
        trackedEvents: whatsappClicks.length,
        opened: null,
        conversionRate: null,
        byDay: perDay(days, whatsappClicks.map((e) => e.created_at))
      }
    ];

    // ── planner: where people stop ──
    // Only sessions the step tracker saw (form_name on the row). Older planner
    // rows have opens but no step events, and counting them would show every
    // one of those visitors leaving at step one.
    const stepTracked = plannerEvents.filter((e) => metaText(e, 'form_name') === PLANNER_FORM);
    const stepOpened = openedSessions(stepTracked, 'plan_my_trip_opened');
    const completedAt = (index: number) =>
      sessionsOf(stepTracked.filter((e) => e.event_name === 'form_step_completed' && metaNumber(e, 'step_index') === index));
    const lastIndex = PLANNER_STEPS.length - 1;
    const stepSubmits = sessionsOf(plannerSubmits.filter((e) => metaText(e, 'form_name') === PLANNER_FORM));
    const completedSets = PLANNER_STEPS.map((_, index) =>
      // The summary step is completed by sending the plan.
      index === lastIndex ? union(completedAt(index), stepSubmits) : completedAt(index)
    );
    // Passing a step means passing every step before it, even when that event
    // fell outside the range — so each step's set holds all the later ones and
    // the funnel can only narrow.
    for (let index = lastIndex - 1; index >= 0; index -= 1) completedSets[index] = union(completedSets[index], completedSets[index + 1]);
    const stepReached0 = union(stepOpened, completedSets[0]);
    const steps = PLANNER_STEPS.map((s, index) => {
      const reached = index === 0 ? stepReached0.size : completedSets[index - 1].size;
      const completed = completedSets[index].size;
      // Floored at 0: a restored draft can complete a step without the one before it in range.
      const dropOffPct = reached > 0 ? Math.max(0, round1(((reached - completed) / reached) * 100)) : 0;
      return { index, key: s.key, label: s.label, reached, completed, dropOffPct };
    });

    const stepLabelByKey = new Map(PLANNER_STEPS.map((s) => [s.key, s.label]));
    const stepLabel = (index: number | null, key: string): string => {
      if (index !== null && index >= 0 && index < PLANNER_STEPS.length) return PLANNER_STEPS[index].label;
      if (key === 'start') return PLANNER_STEPS[0].label;
      return stepLabelByKey.get(key) ?? (key || 'Unknown');
    };

    const validationErrors = tally(
      plannerEvents
        .filter((e) => e.event_name === 'form_validation_error')
        .map((e) => {
          const key = metaText(e, 'step_key');
          return `${stepLabelByKey.get(key) ?? (key || 'Unknown step')} · ${metaText(e, 'field_name') || 'unknown field'}`;
        })
    );
    // Where they left: step_index is where the visitor was (step_key can
    // still name the step just passed), so the index decides.
    // Hiding the tab reports an abandon and coming back clears it, so a session
    // can send several: its last one counts, and only if no submit followed it.
    const lastSubmitAt = new Map<string, number>();
    for (const e of plannerSubmits) if (e.session_id) lastSubmitAt.set(e.session_id, Math.max(lastSubmitAt.get(e.session_id) ?? 0, Date.parse(e.created_at)));
    const lastAbandon = new Map<string, LeadEventRow>();
    const loose: LeadEventRow[] = [];
    for (const e of plannerEvents.filter((row) => row.event_name === 'form_abandoned')) {
      if (!e.session_id) loose.push(e);
      else lastAbandon.set(e.session_id, e); // rows arrive in time order
    }
    const realAbandons = [
      ...loose,
      ...[...lastAbandon.values()].filter((e) => !((lastSubmitAt.get(e.session_id as string) ?? 0) > Date.parse(e.created_at)))
    ];
    const abandonedAt = tally(realAbandons.map((e) => stepLabel(metaNumber(e, 'step_index'), metaText(e, 'step_key'))));

    // ── itinerary form ──
    // Each stage holds everyone who reached a later one, inside the sessions the
    // tracker saw open the form — so the funnel only narrows and its last stage
    // is the tracked submitters (the card's lead count is the database's).
    const itinerarySent = intersect(itineraryTracked, itineraryLeadSessions);
    const itineraryDetails = union(
      sessionsOf(itineraryTrackedEvents.filter((e) => e.event_name === 'form_step_completed' && metaNumber(e, 'step_index') === 0)),
      itinerarySent
    );
    const itineraryStarted = union(
      sessionsOf(itineraryTrackedEvents.filter((e) => e.event_name === 'form_started' || e.event_name === 'form_step_completed')),
      itineraryDetails
    );
    const itineraryStepsTracked = hasStepEvents(itineraryEvents);

    const missingTitles = itineraryBookings
      .filter((b) => !text(bookingContext(b).tour_title) && !text(obj(bookingContext(b).tour).title) && b.tour_id)
      .map((b) => b.tour_id as string);
    const tourTitles = missingTitles.length ? await fetchTourTitles(missingTitles) : new Map<string, string>();
    const topTours = tally(
      itineraryBookings.map(
        (b) =>
          text(bookingContext(b).tour_title) ||
          text(obj(bookingContext(b).tour).title) ||
          (b.tour_id ? tourTitles.get(b.tour_id) : undefined) ||
          'Unknown tour'
      )
    ).slice(0, 10);

    // ── WhatsApp ──
    const whatsapp = {
      byLocation: tally(whatsappClicks.map((e) => metaText(e, 'cta_location') || 'Unknown')),
      byPage: tally(whatsappClicks.map((e) => e.page_path || 'Unknown')).slice(0, 10),
      byTour: tally(
        whatsappClicks.map((e) => metaText(e, 'tour_slug') || text(e.tour_title)).filter(Boolean)
      ).slice(0, 10),
      byDevice: tally(whatsappClicks.map((e) => e.device_type || 'unknown'))
    };

    // ── first-touch source of every lead ──
    const sessionSources = await fetchSessionSources(whatsappClicks.map((e) => e.session_id ?? '').filter(Boolean));
    const sourceRows = new Map<string, { label: string; planner: number; itinerary: number; whatsapp: number; total: number }>();
    const addSource = (label: string, column: 'planner' | 'itinerary' | 'whatsapp') => {
      const row = sourceRows.get(label) ?? { label, planner: 0, itinerary: 0, whatsapp: 0, total: 0 };
      row[column] += 1;
      row.total += 1;
      sourceRows.set(label, row);
    };
    for (const b of plannerBookings) addSource(bookingSource(b), 'planner');
    for (const b of itineraryBookings) addSource(bookingSource(b), 'itinerary');
    for (const e of whatsappClicks) {
      const s = e.session_id ? sessionSources.get(e.session_id) : undefined;
      addSource(
        sourceLabel({ utmSource: text(s?.utm_source), utmMedium: text(s?.utm_medium), referrer: text(s?.referrer) }),
        'whatsapp'
      );
    }
    const sources = [...sourceRows.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label)).slice(0, 12);
    // Is any source recorded at all? Emnel's tracker and lead forms do not yet
    // store referrer/UTM, so every lead reads "Direct / unknown" — a gap in what
    // is recorded, not proof that visitors arrived directly.
    const sourcesTracked =
      sessionSources.size > 0 ||
      [...plannerBookings, ...itineraryBookings].some((b) => Object.keys(obj(bookingContext(b).attribution)).length > 0);

    // ── tracking health + reconciliation ──
    const ga4Count = (name: string) => ga4?.events.find((e) => e.name === name)?.count ?? 0;
    const ga4Lead = (channel: FormChannel) => (ga4?.leadSources ? ga4.leadSources[channel] ?? 0 : null);

    return {
      ok: true,
      range: { from: range.fromIso, to: range.toIso, days: range.days },
      channels,
      planner: {
        stepsTracked: hasStepEvents(plannerEvents),
        steps,
        validationErrors,
        abandonedAt,
        submitErrors: plannerEvents.filter((e) => e.event_name === 'form_submit_error').length,
        byTripType: tally(plannerBookings.flatMap((b) => answerList(bookingAnswer(b, 'travel_interests')))),
        byStage: tally(plannerBookings.map((b) => text(bookingAnswer(b, 'planning_stage')))),
        byComfort: tally(plannerBookings.map((b) => text(bookingAnswer(b, 'accommodation_preference')))),
        byBudget: tally(plannerBookings.map((b) => text(bookingAnswer(b, 'budget_per_person'))))
      },
      itinerary: {
        stepsTracked: itineraryStepsTracked,
        funnel: itineraryStepsTracked
          ? [
              { key: 'opened', label: 'Form seen', value: itineraryTracked.size },
              { key: 'started', label: 'Started', value: itineraryStarted.size },
              { key: 'details', label: 'Trip details done', value: itineraryDetails.size },
              { key: 'submitted', label: 'Request sent', value: itinerarySent.size }
            ]
          : [
              { key: 'opened', label: 'Form seen', value: itineraryTracked.size },
              { key: 'submitted', label: 'Request sent', value: itinerarySent.size }
            ],
        topTours,
        submitErrors: itineraryEvents.filter((e) => e.event_name === 'form_submit_error').length
      },
      whatsapp,
      sources,
      sourcesTracked,
      tracking: {
        ga4: { configured: isGa4Configured(), events: ga4?.events ?? null },
        clarity: { configured: isClarityConfigured(), projectId: env.CLARITY_PROJECT_ID || null },
        inHouse: {
          eventsInRange: Math.max(0, counts.total - counts.dev),
          lastEventAt,
          excludedDevEvents: counts.dev,
          excludedDevLeads
        },
        reconciliation: [
          { channel: 'plan_my_trip', label: CHANNEL_LABELS.plan_my_trip, database: plannerBookings.length, inHouse: plannerSubmits.length, ga4: ga4Lead('plan_my_trip') },
          { channel: 'itinerary_form', label: CHANNEL_LABELS.itinerary_form, database: itineraryBookings.length, inHouse: itinerarySubmits.length, ga4: ga4Lead('itinerary_form') },
          { channel: 'whatsapp', label: CHANNEL_LABELS.whatsapp, database: null, inHouse: whatsappClicks.length, ga4: ga4 ? ga4Count('whatsapp_click') : null }
        ]
      }
    };
  } catch {
    return emptyMainLeads(range);
  }
};
