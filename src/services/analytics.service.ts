import { env } from '../config/env';
import { supabase } from '../config/supabase';
import type { TrackEventInput } from '../schemas/analytics.schema';

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
export const recordEvent = async (input: TrackEventInput, ipHash: string | null): Promise<void> => {
  try {
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
      metadata: scrubMetadata(input.metadata),
      ip_hash: ipHash
    });
  } catch {
    // analytics must never break the request
  }
};

// ── date-range helper ────────────────────────────────────────────────────────
export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | 'this_month' | 'last_month' | 'custom';

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

// ── raw fetchers (fail-silent) ───────────────────────────────────────────────
type EventRow = {
  event_name: string;
  session_id: string | null;
  device_type: string | null;
  destination: string | null;
  tour_title: string | null;
  created_at: string;
};

type BookingRow = {
  id: string;
  source: string | null;
  status: string | null;
  lead_context: Record<string, unknown> | null;
  created_at: string;
};

const fetchEvents = async (fromIso: string, toIso: string): Promise<EventRow[]> => {
  try {
    const { data } = await supabase
      .from('analytics_events')
      .select('event_name,session_id,device_type,destination,tour_title,created_at')
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .limit(100000);
    return (data ?? []) as EventRow[];
  } catch {
    return [];
  }
};

const fetchBookings = async (fromIso: string, toIso: string): Promise<BookingRow[]> => {
  try {
    const { data } = await supabase
      .from('booking_requests')
      .select('id,source,status,lead_context,created_at')
      .is('deleted_at', null)
      .gte('created_at', fromIso)
      .lt('created_at', toIso)
      .limit(100000);
    return (data ?? []) as BookingRow[];
  } catch {
    return [];
  }
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

const pct = (numerator: number, denominator: number) =>
  denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

// ── public aggregations ──────────────────────────────────────────────────────
export const getOverview = async (range: ResolvedRange) => {
  const [events, bookings] = await Promise.all([
    fetchEvents(range.fromIso, range.toIso),
    fetchBookings(range.fromIso, range.toIso)
  ]);

  const count = (name: string) => events.filter((e) => e.event_name === name).length;
  const sessions = new Set(events.map((e) => e.session_id).filter(Boolean)).size;

  const totalLeads = bookings.length;
  const planLeads = bookings.filter((b) => b.source === 'plan_my_trip').length;
  const requestLeads = bookings.filter((b) => b.source === 'website_booking_form').length;
  const aiLeads = bookings.filter((b) => b.source === 'ai_handoff').length;
  const formOpens = count('plan_my_trip_opened') + count('request_trip_opened');

  return {
    visitors: sessions,
    interactions: events.length,
    planMyTripSubmissions: planLeads,
    requestTripSubmissions: requestLeads,
    aiLeads,
    whatsappClicks: count('whatsapp_click'),
    phoneClicks: count('phone_click'),
    emailClicks: count('email_click'),
    aiAdvisorOpened: count('ai_advisor_opened'),
    totalLeads,
    formOpens,
    // Conversion = submitted forms / form opens (first-party funnel).
    formConversionRate: pct(planLeads + requestLeads, formOpens),
    // Lead conversion = visitors who became a lead.
    leadConversionRate: pct(totalLeads, sessions)
  };
};

export const getLeadAnalytics = async (range: ResolvedRange) => {
  const bookings = await fetchBookings(range.fromIso, range.toIso);

  // leads by day
  const byDay = new Map<string, number>();
  for (const b of bookings) byDay.set(dayKey(b.created_at), (byDay.get(dayKey(b.created_at)) ?? 0) + 1);
  const leadsByDay = [...byDay.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));

  const sourceLabels: Record<string, string> = {
    website_booking_form: 'Request This Trip',
    plan_my_trip: 'Plan My Trip',
    ai_handoff: 'AI Advisor',
    whatsapp: 'WhatsApp',
    admin_created: 'Admin',
    hubspot_import: 'HubSpot'
  };

  // experience interests are stored joined ("Safari, Beach") — split them out
  const experiences: string[] = [];
  for (const b of bookings) {
    const raw = lc(b, 'travel_interests') || lc(b, 'experience_interests');
    if (raw) raw.split(',').forEach((part) => experiences.push(part.trim()));
  }

  return {
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

export const getFunnel = async (range: ResolvedRange) => {
  const [events, bookings] = await Promise.all([
    fetchEvents(range.fromIso, range.toIso),
    fetchBookings(range.fromIso, range.toIso)
  ]);
  const count = (name: string) => events.filter((e) => e.event_name === name).length;

  const visitors = new Set(events.map((e) => e.session_id).filter(Boolean)).size;
  const tourViews = count('tour_page_view');
  const formOpens = count('plan_my_trip_opened') + count('request_trip_opened');
  const submitted = bookings.length;
  const contacted = bookings.filter((b) => isContacted(b.status)).length;
  const quoted = bookings.filter((b) => isQuoted(b.status)).length;
  const booked = bookings.filter((b) => isBooked(b.status)).length;

  const stages = [
    { key: 'visitor', label: 'Visitors', value: visitors },
    { key: 'tour_view', label: 'Tour page views', value: tourViews },
    { key: 'form_open', label: 'Form opened', value: formOpens },
    { key: 'submitted', label: 'Form submitted', value: submitted },
    { key: 'contacted', label: 'Contacted', value: contacted },
    { key: 'quoted', label: 'Quoted', value: quoted },
    { key: 'booked', label: 'Booked', value: booked }
  ];

  return {
    stages,
    rates: {
      visitorsToFormOpen: pct(formOpens, visitors),
      formOpenToSubmit: pct(submitted, formOpens),
      submitToContacted: pct(contacted, submitted),
      contactedToBooked: pct(booked, contacted)
    }
  };
};

export const getEventTimeseries = async (range: ResolvedRange) => {
  const events = await fetchEvents(range.fromIso, range.toIso);

  // sessions (unique) + key interaction counts per day
  const days = new Map<string, { sessions: Set<string>; whatsapp: number; ai: number; events: number }>();
  for (const e of events) {
    const d = dayKey(e.created_at);
    const bucket = days.get(d) ?? { sessions: new Set<string>(), whatsapp: 0, ai: 0, events: 0 };
    if (e.session_id) bucket.sessions.add(e.session_id);
    if (e.event_name === 'whatsapp_click') bucket.whatsapp += 1;
    if (e.event_name.startsWith('ai_advisor')) bucket.ai += 1;
    bucket.events += 1;
    days.set(d, bucket);
  }

  const deviceTally = tally(events.map((e) => e.device_type ?? 'unknown'));

  return {
    byDay: [...days.entries()]
      .map(([date, b]) => ({ date, visitors: b.sessions.size, whatsapp: b.whatsapp, ai: b.ai, events: b.events }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byDevice: deviceTally,
    topEvents: tally(events.map((e) => e.event_name))
  };
};
