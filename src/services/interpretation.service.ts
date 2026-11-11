import { supabase } from '../config/supabase';
import {
  getEventTimeseries, getMainLeads, getOverview, type LeadChannel, type MainLeads, type ResolvedRange
} from './analytics.service';
import { getGa4LastHost, getTraffic, type Ga4LastHost, type Ga4Traffic } from './ga4.service';

// ----------------------------------------------------------------------------
// Interpretation — the plain-words reading at the top of the analytics page.
// A fixed set of rules (R1–R11 below) reads figures we already hold: the three
// main leads and their previous period, the planner and itinerary funnels,
// WhatsApp taps, first-touch sources, visitors (the in-house tracker's real
// visitors; GA4 only for its own trend while it is still counting) and the
// Bookings table. It writes one headline and a short list of findings, each
// carrying the numbers behind it and a next step. Nothing is generated or
// estimated: a rule whose data is missing or too thin says nothing (no
// padding), a change on a base under 5 is told as two counts and never as a
// percentage, and no finding claims a cause the data cannot show. When the
// main-lead report could not be read completely there are no findings at all.
// Development and automated traffic are already out of every figure read here.
// ----------------------------------------------------------------------------

export type FindingKind = 'win' | 'watch' | 'problem' | 'opportunity';
export type FindingArea =
  | 'leads' | 'planner' | 'itinerary' | 'whatsapp' | 'sources' | 'follow_up' | 'demand' | 'traffic' | 'tracking';

export type Finding = {
  id: string; // stable rule id
  kind: FindingKind;
  area: FindingArea;
  title: string; // plain words, the number in it
  evidence: string; // the figures behind it
  action: string | null; // a concrete next step, or null when there is nothing to do
  source: 'website' | 'ga4' | 'clarity'; // 'website' is shown as "In-house"
  confidence: 'solid' | 'early'; // early: the base count is under 20
  anchor: string | null; // the section of the page holding the detail
};

export type Interpretation = {
  /** false: a read behind the reading failed — the panel says so instead of "nothing to read". */
  ok: boolean;
  headline: string | null;
  findings: Finding[];
  /** visitors: the in-house real-visitor count (the Visitors card); visitorsSource names it. */
  basis: { from: string; to: string; days: number; leads: number; visitors: number | null; visitorsSource: 'website' | null };
};

type Overview = Awaited<ReturnType<typeof getOverview>>;
type Timeseries = Awaited<ReturnType<typeof getEventTimeseries>>;

/** Reads a caller already has in flight, handed over so nothing is fetched twice. */
export type SharedReads = {
  overview?: Promise<Overview | null>;
  timeseries?: Promise<Timeseries | null>;
  traffic?: Promise<Ga4Traffic | null>;
};

/** A main-lead booking still marked 'pending' more than a day after it arrived. */
type WaitingLead = { source: 'plan_my_trip' | 'website_booking_form'; createdAt: string };

export type InterpretationInput = {
  range: ResolvedRange;
  now: Date;
  mainLeads: MainLeads;
  overview: Overview | null;
  timeseries: Timeseries | null;
  traffic: Ga4Traffic | null;
  /** null: the Bookings read failed, so the follow-up rule stays quiet. */
  waiting: WaitingLead[] | null;
  /** The host GA4's property last received visits on, for the GA4-silent finding (null: unknown). */
  ga4Host?: Ga4LastHost | null;
};

const MAX_FINDINGS = 8;
const SETTLED_SHARE = 0.9; // under this share of the range passed, a fall is not told yet
const EARLY_BELOW = 20; // a base under this many is an early signal
const SMALL_BASE = 5; // under this, changes are told as two counts, never a %
const DAY_MS = 86_400_000;
const DIRECT = 'Direct / unknown';
const MAIN_LEAD_SOURCES = ['plan_my_trip', 'website_booking_form'] as const;
const KIND_ORDER: Record<FindingKind, number> = { problem: 0, watch: 1, opportunity: 2, win: 3 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ── wording helpers ──────────────────────────────────────────────────────────
const fmt = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
/** 'YYYY-MM-DD' → '28 Sep'. */
const dayLabel = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
const confidenceOf = (n: number): Finding['confidence'] => (n < EARLY_BELOW ? 'early' : 'solid');
/** Per-day average in owner words: one decimal under 10, whole numbers above. */
const perDay = (total: number, days: number) => {
  const avg = total / days;
  return avg < 10 ? String(Math.round(avg * 10) / 10) : fmt(Math.round(avg));
};

/** Every day in the range as 'YYYY-MM-DD' (toIso is exclusive). */
const daysOf = (range: ResolvedRange): string[] => {
  const out: string[] = [];
  const end = Date.parse(range.toIso);
  for (let t = Date.parse(range.fromIso); t < end && out.length < 1000; t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/** "in the last 30 days", "today", or "from 1 Sep to 30 Sep" for a range that ended. */
const periodPhrase = (range: ResolvedRange, days: string[], now: Date): string => {
  const today = now.toISOString().slice(0, 10);
  const first = days[0] ?? range.fromIso.slice(0, 10);
  const last = days[days.length - 1] ?? first;
  if (last >= today) return days.length <= 1 ? 'today' : `in the last ${days.length} days`;
  if (first === last) return `on ${dayLabel(first)}`;
  return `from ${dayLabel(first)} to ${dayLabel(last)}`;
};

const previousPhrase = (days: number) => (days === 1 ? 'the day before' : `the previous ${days} days`);

// How each main lead is named in a sentence.
const CHANNEL_WORDS: Record<LeadChannel, {
  name: string; unit: [string, string]; thing: [string, string]; area: FindingArea; from: string; check: string;
}> = {
  plan_my_trip: {
    name: 'Plan My Trip', unit: ['lead', 'leads'], thing: ['saved plan', 'saved plans'], area: 'planner', from: 'database',
    check: 'Open Plan My Trip under Main leads to see which step people stop at.'
  },
  itinerary_form: {
    name: 'the itinerary form', unit: ['lead', 'leads'], thing: ['itinerary request', 'itinerary requests'], area: 'itinerary', from: 'database',
    check: 'Open the itinerary form under Main leads to see where requests stop.'
  },
  whatsapp: {
    name: 'WhatsApp', unit: ['tap', 'taps'], thing: ['WhatsApp tap', 'WhatsApp taps'], area: 'whatsapp', from: 'in-house tracker',
    check: 'Open WhatsApp under Main leads to see which buttons and pages still get taps.'
  }
};

// R3: what to try at the planner step where most people stop.
const STEP_ACTIONS: Record<string, string> = {
  trip_type: "Show 'Not sure yet' more prominently and shorten the list of trip types.",
  travellers: "Keep children's ages optional.",
  when: "Make 'Not sure yet' obvious for the dates.",
  length_pace: 'Pre-select the most popular trip length.',
  preferences: 'Make the budget optional and explain why it is asked.',
  planning_stage: 'Keep this step to one tap.',
  summary: 'Ask only for name and email first; keep the phone optional unless WhatsApp is chosen.'
};

// R4: what to try at the itinerary-form hand-off that loses the most people.
const HANDOFF_WORDS: Record<string, { title: (pct: number) => string; action: string }> = {
  started: {
    title: (pct) => `Only ${pct}% of people who see the itinerary form start filling it in`,
    action: 'Make the first question quick to answer — one tap if possible.'
  },
  details: {
    title: (pct) => `Only ${pct}% of people who start the itinerary form finish the trip details`,
    action: 'Trim the trip-details step to what a first itinerary needs, and let dates be approximate.'
  },
  submitted: {
    title: (pct) => `Only ${pct}% of people who finish the trip details send the request`,
    action: 'Ask only for name and email to send; keep the phone optional unless they choose WhatsApp.'
  }
};

// R4, when the form reports only opened and sent (no step events).
const OPEN_TO_SENT_WORDS = {
  title: (pct: number) => `Only ${pct}% of people who see the itinerary form send it`,
  action: 'Keep the form to what a first itinerary needs, let dates be approximate, and keep the phone optional unless they choose WhatsApp.'
};

// R5: where a WhatsApp button sits, from the cta_location the site sends.
const LOCATION_WORDS: Record<string, string> = {
  header: 'the header',
  footer: 'the footer',
  navigation: 'the menu',
  page_content: 'buttons inside the page'
};
const locationWords = (label: string) => LOCATION_WORDS[label] ?? `the ${label.replace(/[_-]+/g, ' ').trim()}`;
const pageWords = (path: string) => (path === '/' ? 'the home page' : path);
const tallyLine = (rows: Array<{ label: string; value: number }>, limit = 4) =>
  rows.slice(0, limit).map((r) => `${r.label} ${fmt(r.value)}`).join(' · ');

// Development hosts, the same rule analytics.service applies to every report:
// localhost and its kin, an IP address, or an explicit port.
const NON_TRAFFIC_HOST = /^(localhost|0\.0\.0\.0|\[[0-9a-f:.]+\]|\d{1,3}(\.\d{1,3}){3})$|\.(localhost|local|test|internal|lan)$/i;
const isDevUrl = (url: string | null | undefined): boolean => {
  if (!url) return false;
  try {
    const u = new URL(url);
    return Boolean(u.port) || NON_TRAFFIC_HOST.test(u.hostname);
  } catch {
    return false;
  }
};

/**
 * R7's read: Plan My Trip and itinerary-form bookings in the range that are
 * still 'pending' and arrived more than 24 h ago. Bookings sent from a
 * development site (a test) are left out, as the main-leads report does.
 * Fail-silent: null means "could not tell", never "none waiting".
 */
const fetchWaitingLeads = async (range: ResolvedRange, now: Date): Promise<WaitingLead[] | null> => {
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const upTo = dayAgo < range.toIso ? dayAgo : range.toIso;
  if (upTo <= range.fromIso) return [];
  try {
    const { data, error } = await supabase
      .from('booking_requests')
      .select('source,created_at,page_url:lead_context->page->>url,source_page_url:lead_context->>source_page_url')
      .is('deleted_at', null)
      .eq('status', 'pending')
      .in('source', [...MAIN_LEAD_SOURCES])
      .gte('created_at', range.fromIso)
      .lt('created_at', upTo)
      .order('created_at', { ascending: true })
      .limit(1000);
    if (error) return null;
    const rows = (data ?? []) as unknown as Array<{
      source: WaitingLead['source']; created_at: string; page_url: string | null; source_page_url: string | null;
    }>;
    return rows
      .filter((row) => !isDevUrl(row.page_url || row.source_page_url))
      .map((row) => ({ source: row.source, createdAt: row.created_at }));
  } catch {
    return null;
  }
};

const emptyInterpretation = (range: ResolvedRange, ok = false): Interpretation => ({
  ok,
  headline: null,
  findings: [],
  basis: { from: range.fromIso, to: range.toIso, days: range.days, leads: 0, visitors: null, visitorsSource: null }
});

/** The rules themselves — pure, so every finding can be checked against its input. */
export const interpret = (input: InterpretationInput): Interpretation => {
  const { range, now, mainLeads: ml, timeseries, traffic, waiting } = input;
  // An overview that could not be read completely is unknown, not zero.
  const overview = input.overview?.ok === false ? null : input.overview;
  const days = daysOf(range);
  const today = now.toISOString().slice(0, 10);
  const completeDays = days.filter((d) => d < today); // today is not over yet
  const period = periodPhrase(range, days, now);
  const previous = previousPhrase(range.days);
  // How much of the range has passed: a range that includes today is compared
  // with the previous period scaled to the same share.
  const fromMs = Date.parse(range.fromIso);
  const toMs = Date.parse(range.toIso);
  const elapsed = now.getTime() >= toMs ? 1 : Math.max(0, (now.getTime() - fromMs) / (toMs - fromMs));
  const findings: Finding[] = [];
  const add = (f: Omit<Finding, 'confidence'> & { n: number; confidence?: Finding['confidence'] }) => {
    const { n, confidence, ...rest } = f;
    findings.push({ ...rest, confidence: confidence ?? confidenceOf(n) });
  };

  const channelOf = (key: LeadChannel) =>
    ml.channels.find((c) => c.key === key) ?? { key, leads: 0, previous: 0, byDay: [] as Array<{ date: string; value: number }> };
  const planner = channelOf('plan_my_trip');
  const itinerary = channelOf('itinerary_form');
  const whatsapp = channelOf('whatsapp');
  const totalLeads = planner.leads + itinerary.leads + whatsapp.leads;

  // ── visitors: the in-house tracker's real visitors; GA4 only for its own trend ──
  const ga4Connected = Boolean(traffic?.configured) && !traffic?.error;
  const ga4Users = new Map((traffic?.byDay ?? []).map((d) => [d.date, d.users]));
  const ga4Days = days.filter((d) => (ga4Users.get(d) ?? 0) > 0);
  const ga4Usable = ga4Connected && ga4Days.length > 0;
  const lastGa4Day = ga4Days[ga4Days.length - 1] ?? null;
  const inHouseVisitors = new Map((timeseries?.byDay ?? []).map((d) => [d.date, d.visitors]));

  // R9b — GA4 gone quiet: whole days after GA4's last figure on which the
  // in-house tracker still saw visits. GA4 normally reports within a day or
  // two, so three or more silent days are a gap, not a delay.
  const silentDays = ga4Connected ? completeDays.filter((d) => !lastGa4Day || d > lastGa4Day) : [];
  const silentButVisited = silentDays.filter((d) => (inHouseVisitors.get(d) ?? 0) > 0);
  const ga4Silent = silentDays.length >= 3 && silentButVisited.length >= 3;

  // ── R7 follow-up: leads still waiting for a first reply ──
  if (waiting && waiting.length > 0) {
    const n = waiting.length;
    const plans = waiting.filter((w) => w.source === 'plan_my_trip').length;
    const requests = n - plans;
    const waitedDays = Math.max(1, Math.floor((now.getTime() - Date.parse(waiting[0].createdAt)) / DAY_MS));
    const parts = [plans ? plural(plans, 'Plan My Trip plan') : '', requests ? plural(requests, 'itinerary request') : ''].filter(Boolean);
    add({
      id: 'follow-up-waiting', kind: 'problem', area: 'follow_up',
      title: `${plural(n, 'lead')} ${n === 1 ? 'has' : 'have'} waited over a day for a first reply`,
      evidence: `${parts.join(' and ')} received ${period} ${n === 1 ? 'is' : 'are'} still marked 'pending' in Bookings more than 24 hours after arriving (database).`,
      action: `Reply from Bookings and update each status — the oldest has waited ${plural(waitedDays, 'day')}.`,
      source: 'website', n, confidence: 'solid', anchor: '#sec-leads'
    });
  }

  // ── R3 planner drop-off: the step that loses the largest share ──
  const stepCandidates = ml.planner.steps.filter((s) => s.reached >= 10);
  if (stepCandidates.length) {
    const worst = stepCandidates.reduce((a, b) => (b.dropOffPct > a.dropOffPct ? b : a));
    if (worst.dropOffPct >= 25) {
      const stopped = Math.max(0, worst.reached - worst.completed);
      const pct = Math.round(worst.dropOffPct);
      const reachedLine = worst.key === 'summary'
        ? `${fmt(worst.reached)} reached the summary and ${fmt(worst.completed)} sent their plan`
        : `${fmt(worst.reached)} reached ${worst.label} and ${fmt(worst.completed)} went on`;
      const errors = ml.planner.validationErrors.filter((e) => e.label.startsWith(`${worst.label} · `));
      const errorLine = errors.length
        ? ` The most frequent error there: ${errors[0].label.slice(worst.label.length + 3)} (${plural(errors[0].value, 'time')}).`
        : '';
      add({
        id: 'planner-dropoff', kind: worst.dropOffPct >= 40 ? 'problem' : 'watch', area: 'planner',
        title: `Plan My Trip loses ${pct}% of people at the ${worst.label} step`,
        evidence: `${reachedLine} — ${fmt(stopped)} stopped there ${period} (in-house tracker, visitors who allow analytics).${errorLine}`,
        action: STEP_ACTIONS[worst.key] ?? null,
        source: 'website', n: worst.reached, anchor: '#sec-main-leads'
      });
    }
  }

  // ── R4 itinerary hand-off: the weakest step between two funnel stages ──
  let weakest: { from: MainLeads['itinerary']['funnel'][number]; to: MainLeads['itinerary']['funnel'][number]; pct: number } | null = null;
  const funnel = ml.itinerary.funnel;
  for (let i = 0; i < funnel.length - 1; i += 1) {
    const from = funnel[i];
    const to = funnel[i + 1];
    if (from.value < 10) continue;
    const pct = (to.value / from.value) * 100;
    if (!weakest || pct < weakest.pct) weakest = { from, to, pct };
  }
  // Without step tracking the funnel is only Form seen → Request sent.
  const handoffWords = (from: string, to: string) =>
    from === 'opened' && to === 'submitted' ? OPEN_TO_SENT_WORDS : HANDOFF_WORDS[to];
  if (weakest && weakest.pct < 60 && handoffWords(weakest.from.key, weakest.to.key)) {
    const words = handoffWords(weakest.from.key, weakest.to.key);
    add({
      id: 'itinerary-handoff', kind: weakest.pct < 40 ? 'problem' : 'watch', area: 'itinerary',
      title: words.title(Math.round(weakest.pct)),
      evidence: `${fmt(weakest.to.value)} of ${fmt(weakest.from.value)} went from '${weakest.from.label}' to '${weakest.to.label}' ${period} (in-house tracker, visitors who allow analytics).`,
      action: words.action,
      source: 'website', n: weakest.from.value, anchor: '#sec-main-leads'
    });
  }

  // ── R9b GA4 silent (see above) ──
  // The host the property last heard from names the site it is really measuring.
  if (ga4Silent) {
    const host = input.ga4Host ?? null;
    const since = lastGa4Day ?? (host && host.date < days[0] ? host.date : null);
    const hostLine = host
      ? `The property the CMS reads last received visits from ${host.host}${host.date !== since ? ` (on ${dayLabel(host.date)})` : ''} — the live site's tag may be sending to another GA4 property. `
      : '';
    add({
      id: 'tracking-ga4-silent', kind: 'watch', area: 'tracking',
      title: since ? `GA4 hasn't counted a visitor since ${dayLabel(since)}` : `GA4 hasn't counted a visitor ${period}`,
      evidence: `${hostLine}GA4 reports nobody on the ${plural(silentDays.length, 'full day')} ${lastGa4Day ? `after ${dayLabel(lastGa4Day)}` : 'in this period'}, while the in-house tracker recorded visits on ${fmt(silentButVisited.length)} of them; GA4 figures normally arrive within a day or two.`,
      action: 'Check GA4 Admin › Data streams for the measurement ID on the site.',
      source: 'ga4', n: silentDays.length, confidence: 'solid', anchor: '#sec-traffic'
    });
  }

  // ── R9 tracking gap: the tracker saw far fewer form leads than the database holds ──
  for (const row of ml.tracking.reconciliation) {
    if (row.channel === 'whatsapp' || row.database === null || row.database < 5) continue;
    if (row.inHouse / row.database >= 0.7) continue;
    const words = CHANNEL_WORDS[row.channel];
    add({
      id: `tracking-gap-${row.channel}`, kind: 'watch', area: 'tracking',
      title: `The tracker saw ${fmt(row.inHouse)} of ${fmt(row.database)} ${row.channel === 'plan_my_trip' ? 'Plan My Trip' : 'itinerary form'} leads`,
      evidence: `${plural(row.database, words.thing[0], words.thing[1])} in the database vs ${plural(row.inHouse, 'send')} seen by the in-house tracker ${period}. Some visitors decline cookies or block tracking, so lead counts here come from the database and are complete; step and drop-off figures cover only the visitors the tracker saw.`,
      action: null,
      source: 'website', n: row.database, anchor: '#sec-main-leads'
    });
  }

  // ── R1 channel trend: each main lead against the previous period of equal length ──
  // A move smaller than the one that raises a watch (20%, or 3 on a base
  // under 5) reads as flat, in either direction, and says nothing. A range
  // still running is held against the share of the previous period that
  // matches the time passed, and a fall is not told before 90% has passed.
  for (const c of [planner, itinerary, whatsapp].sort((a, b) => b.leads - a.leads)) {
    const words = CHANNEL_WORDS[c.key];
    const current = c.leads;
    const before = c.previous;
    if (current === 0 && before === 0) continue;
    const expected = before * elapsed; // the previous period scaled to the share of this one passed
    const delta = current - expected;
    const pct = expected >= SMALL_BASE ? Math.round((delta / expected) * 100) : null;
    const up = pct !== null ? pct >= 20 : delta >= 3;
    const down = pct !== null ? pct <= -20 : delta <= -3;
    if (!up && !down) continue;
    if (down && elapsed < SETTLED_SHARE) continue;
    const move = pct !== null ? `${up ? 'up' : 'down'} ${Math.abs(pct)}%` : `${up ? 'up' : 'down'} from ${fmt(before)}`;
    const verb = c.key === 'whatsapp' ? 'got' : 'brought';
    // Said whenever the scaling changes the figure compared with.
    const shown = Math.round(expected * 10) / 10;
    const scaled = shown !== before
      ? ` This period is ${Math.floor(elapsed * 100)}% through, so it is compared with that share of the previous figure (${shown.toLocaleString('en-US')}).`
      : '';
    add({
      id: `trend-${c.key}`, kind: up ? 'win' : 'watch', area: words.area,
      title: `${cap(words.name)} ${verb} ${plural(current, words.unit[0], words.unit[1])}, ${move}`,
      evidence: `${plural(current, words.thing[0], words.thing[1])} ${period} vs ${fmt(before)} in ${previous} (${words.from}).${scaled}`,
      action: down ? words.check : null,
      source: 'website', n: current + before, anchor: '#sec-main-leads'
    });
  }

  // ── R10 traffic trend: second half of the period against the first ──
  // GA4 while it is still counting; once it has gone quiet, the in-house
  // tracker's real visitors (automated networks out). "Lately" only when the
  // later half runs up to the last whole day.
  {
    const useGa4 = ga4Usable && !ga4Silent;
    const series = useGa4 ? ga4Users : inHouseVisitors;
    let span = useGa4 ? completeDays.filter((d) => lastGa4Day !== null && d <= lastGa4Day) : completeDays;
    const firstSeen = span.findIndex((d) => (series.get(d) ?? 0) > 0); // before this the tracker was not collecting yet
    span = firstSeen === -1 ? [] : span.slice(firstSeen);
    const half = Math.floor(span.length / 2);
    if (half >= 3) {
      const before = span.slice(0, half);
      const after = span.slice(span.length - half);
      const s1 = sum(before.map((d) => series.get(d) ?? 0));
      const s2 = sum(after.map((d) => series.get(d) ?? 0));
      if (s1 + s2 >= 100 && s1 > 0) {
        const change = Math.round(((s2 - s1) / s1) * 100);
        if (Math.abs(change) >= 15) {
          const up = change > 0;
          const from = useGa4 ? 'GA4, visitors who accepted cookies' : 'in-house tracker, automated traffic left out';
          const lately = after[after.length - 1] === completeDays[completeDays.length - 1];
          const afterSpan = `${dayLabel(after[0])} to ${dayLabel(after[after.length - 1])}`;
          const beforeSpan = `${dayLabel(before[0])} to ${dayLabel(before[before.length - 1])}`;
          add({
            id: 'traffic-trend', kind: up ? 'win' : 'watch', area: 'traffic',
            title: lately
              ? `Visitors are ${up ? 'up' : 'down'} ${Math.abs(change)}% — about ${perDay(s2, half)} a day lately, ${perDay(s1, half)} before`
              : `Visitors were ${up ? 'up' : 'down'} ${Math.abs(change)}% — about ${perDay(s2, half)} a day from ${afterSpan}, ${perDay(s1, half)} from ${beforeSpan}`,
            evidence: `${plural(s2, 'visitor')} from ${afterSpan} vs ${fmt(s1)} from ${beforeSpan} (${from}, ${half} full days each).`,
            action: up ? null : 'Open Traffic to see which source fell.',
            source: useGa4 ? 'ga4' : 'website', n: s1 + s2, anchor: '#sec-traffic'
          });
        }
      }
    }
  }

  // ── R11 visitor → lead: main leads per in-house real visitor ──
  // The same visitor count as the Visitors card. GA4 counts only visitors who
  // accepted cookies while leads come from everyone, so it is never the base.
  {
    const visitors = overview ? overview.visitors : null;
    if (visitors !== null && visitors >= 200) {
      const rate = (totalLeads / visitors) * 100;
      const oneIn = totalLeads > 0 ? Math.round(visitors / totalLeads) : null;
      const kind: FindingKind | null = rate < 1 ? 'watch' : rate >= 3 ? 'win' : null;
      if (kind) {
        add({
          id: 'visitor-to-lead', kind, area: 'leads',
          title: oneIn === null
            ? `None of ${fmt(visitors)} visitors became a lead`
            : `${kind === 'watch' ? 'Only about' : 'About'} 1 in ${fmt(oneIn)} visitors becomes a lead (${rate.toFixed(1)}%)`,
          evidence: `${plural(totalLeads, 'main lead')} from ${plural(visitors, 'visitor')} ${period} (visitors from the in-house tracker, automated traffic left out; leads from the database and in-house tracker).`,
          action: kind === 'watch' ? 'Open the Funnel to see where visitors stop before asking.' : null,
          source: 'website', n: visitors, anchor: '#sec-funnel'
        });
      }
    }
  }

  // ── R6 sources: untagged traffic, and the best first-touch source ──
  const sources = ml.sources;
  // Only when sources are recorded: if nothing stores referrer/UTM, "Direct"
  // is a recording gap, and tagging links alone would not change it.
  if (ml.sourcesTracked && totalLeads >= 5 && sources.length) {
    const direct = sources.find((s) => s.label === DIRECT);
    const directShare = direct ? direct.total / totalLeads : 0;
    const known = sources.filter((s) => s.label !== DIRECT);
    if (direct && directShare >= 0.6) {
      add({
        id: 'sources-untagged', kind: 'opportunity', area: 'tracking',
        title: `${fmt(direct.total)} of ${plural(totalLeads, 'lead')} arrive with no known source`,
        evidence: `First-touch source of each main lead ${period}: ${tallyLine(sources.map((s) => ({ label: s.label, value: s.total })))} (in-house tracker + database).`,
        action: 'Tag the links you share (social posts, emails, partner sites) with utm_source and utm_medium so these leads stop showing as Direct.',
        source: 'website', n: totalLeads, anchor: '#sec-main-leads'
      });
    }
    // The best source is a named one: the top row when it is not Direct (and
    // nothing ties it), or the strongest named one when Direct leads but stays
    // under 60%. A tie names no winner.
    const best = sources[0].label !== DIRECT ? sources[0] : directShare < 0.6 ? known[0] : undefined;
    const rivals = best === sources[0] ? sources : known;
    const runnerUp = best ? rivals.find((s) => s !== best) : undefined;
    if (best && best.total >= 2 && (!runnerUp || runnerUp.total < best.total)) {
      add({
        id: 'sources-best', kind: 'win', area: 'sources',
        title: best === sources[0]
          ? `${best.label} brings the most leads: ${fmt(best.total)} of ${fmt(totalLeads)}`
          : `${best.label} is the strongest named source: ${fmt(best.total)} of ${plural(totalLeads, 'lead')}`,
        evidence: `First-touch source of each main lead ${period}: ${tallyLine(sources.map((s) => ({ label: s.label, value: s.total })))} (in-house tracker + database).`,
        action: null,
        source: 'website', n: totalLeads, anchor: '#sec-main-leads'
      });
    }
  }

  // ── R9 GA4 lead split: generate_lead cannot be split by form yet ──
  const ga4Leads = ml.tracking.ga4;
  const plannerRecon = ml.tracking.reconciliation.find((r) => r.channel === 'plan_my_trip');
  if (ga4Leads.configured && ga4Leads.events && plannerRecon && plannerRecon.ga4 === null) {
    const generated = ga4Leads.events.find((e) => e.name === 'generate_lead')?.count ?? 0;
    add({
      id: 'tracking-ga4-lead-source', kind: 'opportunity', area: 'tracking',
      title: "GA4 can't tell Plan My Trip leads from itinerary leads yet",
      evidence: `GA4 recorded ${plural(generated, 'generate_lead event')} ${period}, but lead_source is not registered as a custom dimension, so GA4 cannot split them by form.`,
      action: 'Register lead_source as a custom dimension in GA4 (Admin › Custom definitions, event scope).',
      source: 'ga4', n: generated, confidence: 'solid', anchor: '#sec-main-leads'
    });
  }

  // ── R5 WhatsApp hotspots: the button, and the page, most taps come from ──
  const taps = whatsapp.leads;
  if (taps >= 5) {
    const knownLocations = ml.whatsapp.byLocation.filter((l) => l.label !== 'Unknown');
    const top = knownLocations[0];
    if (top && top.value / taps >= 0.4 && (knownLocations[1]?.value ?? 0) < top.value) {
      const where = locationWords(top.label);
      const majority = top.value * 2 > taps;
      add({
        id: 'whatsapp-location', kind: majority ? 'win' : 'opportunity', area: 'whatsapp',
        title: majority
          ? `Most WhatsApp taps come from ${where} (${fmt(top.value)} of ${fmt(taps)})`
          : `More WhatsApp taps come from ${where} than anywhere else (${fmt(top.value)} of ${fmt(taps)})`,
        evidence: `WhatsApp taps by button ${period}: ${tallyLine(ml.whatsapp.byLocation)} (in-house tracker).`,
        action: 'Keep that button where it is and in view on every page, tour pages included.',
        source: 'website', n: taps, anchor: '#sec-main-leads'
      });
    }
    const knownPages = ml.whatsapp.byPage.filter((p) => p.label !== 'Unknown');
    const topPage = knownPages[0];
    if (topPage && topPage.value / taps >= 0.4 && (knownPages[1]?.value ?? 0) < topPage.value) {
      add({
        id: 'whatsapp-page', kind: 'opportunity', area: 'whatsapp',
        title: `${fmt(topPage.value)} of ${fmt(taps)} WhatsApp taps came from ${pageWords(topPage.label)}`,
        evidence: `WhatsApp taps by page ${period}: ${tallyLine(ml.whatsapp.byPage)} (in-house tracker).`,
        action: 'Keep the WhatsApp button on that page in view and its details current.',
        source: 'website', n: taps, anchor: '#sec-main-leads'
      });
    }
  }

  // ── R8 demand: the most requested tour, or the most chosen trip type ──
  // A leader tied with the next one is no leader: that side says nothing.
  // When the tour and the trip type lead by the same share, both are named.
  {
    const leader = (rows: Array<{ label: string; value: number }>, skip: string) => {
      const known = rows.filter((t) => t.label !== skip);
      return known[0] && (known[1]?.value ?? 0) < known[0].value ? known[0] : undefined;
    };
    const tour = leader(ml.itinerary.topTours, 'Unknown tour');
    const tripType = leader(ml.planner.byTripType, 'Not specified');
    const tourShare = tour && tour.value >= 3 && itinerary.leads > 0 ? tour.value / itinerary.leads : -1;
    const typeShare = tripType && tripType.value >= 3 && planner.leads > 0 ? tripType.value / planner.leads : -1;
    if (tour && tourShare >= 0 && tourShare >= typeShare) {
      add({
        id: 'demand-tour', kind: 'win', area: 'demand',
        title: `Most requested tour: ${tour.label} (${fmt(tour.value)} of ${plural(itinerary.leads, 'itinerary request')})`,
        evidence: `${fmt(tour.value)} of ${plural(itinerary.leads, 'itinerary request')} ${period} named this tour (database).`,
        action: 'Keep its dates, prices and photos current — it is the tour people ask for most.',
        source: 'website', n: itinerary.leads, anchor: '#sec-main-leads'
      });
    }
    if (tripType && typeShare >= 0 && typeShare >= tourShare) {
      add({
        id: 'demand-trip-type', kind: 'win', area: 'demand',
        title: `${tripType.label} is the most chosen trip type in Plan My Trip (${fmt(tripType.value)} of ${plural(planner.leads, 'plan')})`,
        evidence: `${fmt(tripType.value)} of ${plural(planner.leads, 'saved plan')} ${period} picked ${tripType.label}; a plan can pick more than one (database).`,
        action: null,
        source: 'website', n: planner.leads, anchor: '#sec-main-leads'
      });
    }
  }

  // ── R2 channel mix: which main lead brings the largest share ──
  if (totalLeads >= 3) {
    const ranked = [planner, itinerary, whatsapp].sort((a, b) => b.leads - a.leads);
    const topLeads = ranked[0].leads;
    const leaders = ranked.filter((c) => c.leads === topLeads);
    if (topLeads > 0 && leaders.length < ranked.length) {
      const names = leaders.map((c) => CHANNEL_WORDS[c.key].name);
      add({
        id: 'channel-mix', kind: 'win', area: 'leads',
        title: leaders.length === 1
          ? `${cap(names[0])} brings the most leads: ${fmt(topLeads)} of ${fmt(totalLeads)}`
          : `${cap(names.join(' and '))} bring the most leads: ${fmt(topLeads)} each of ${fmt(totalLeads)}`,
        evidence: `Plan My Trip ${fmt(planner.leads)} · itinerary form ${fmt(itinerary.leads)} · WhatsApp taps ${fmt(whatsapp.leads)} ${period} (database + in-house tracker).`,
        action: null,
        source: 'website', n: totalLeads, anchor: '#sec-main-leads'
      });
    }
  }

  // ── order: problems, then watch, opportunity, win; solid before early; rule order otherwise ──
  const ordered = findings
    .map((f, i) => ({ f, i }))
    .sort((a, b) =>
      KIND_ORDER[a.f.kind] - KIND_ORDER[b.f.kind] ||
      (a.f.confidence === b.f.confidence ? 0 : a.f.confidence === 'solid' ? -1 : 1) ||
      a.i - b.i)
    .slice(0, MAX_FINDINGS)
    .map(({ f }) => f);

  // ── headline + basis ──
  // Visitors are the in-house real-visitor count — the Visitors card: every
  // session with a page view over the whole period, automated networks out.
  // Never a GA4 figure, which covers only visitors who accepted cookies.
  const visitorsForPeriod = overview ? overview.visitors : null;
  const visitorsPart = visitorsForPeriod ? ` from ${plural(visitorsForPeriod, 'visitor')}` : '';
  let headline: string | null = null;
  if (totalLeads > 0) {
    headline = `${plural(totalLeads, 'main lead')}${visitorsPart} ${period} — ${fmt(planner.leads)} from Plan My Trip, ${fmt(itinerary.leads)} from tour pages, ${plural(whatsapp.leads, 'WhatsApp tap')}.`;
  } else if (visitorsForPeriod) {
    headline = `${cap(plural(visitorsForPeriod, 'visitor'))} ${period}, but no main leads yet.`;
  }

  return {
    ok: true,
    headline,
    findings: ordered,
    basis: {
      from: range.fromIso, to: range.toIso, days: range.days, leads: totalLeads,
      visitors: visitorsForPeriod, visitorsSource: visitorsForPeriod !== null ? 'website' : null
    }
  };
};

/**
 * The interpretation for a range. Reads the main leads, visitors and waiting
 * bookings in parallel (reusing any reads the caller already has in flight)
 * and applies the rules. Never throws: on any failure — or when the main-lead
 * report could not be read completely — it returns no findings.
 */
export const buildInterpretation = async (range: ResolvedRange, shared: SharedReads = {}): Promise<Interpretation> => {
  const now = new Date();
  try {
    const [mainLeads, overview, timeseries, traffic, waiting, ga4Host] = await Promise.all([
      getMainLeads(range),
      (shared.overview ?? getOverview(range)).catch(() => null),
      (shared.timeseries ?? getEventTimeseries(range)).catch(() => null),
      (shared.traffic ?? getTraffic(range)).catch(() => null),
      fetchWaitingLeads(range, now),
      getGa4LastHost().catch(() => null)
    ]);
    if (!mainLeads.ok) return emptyInterpretation(range);
    return interpret({ range, now, mainLeads, overview, timeseries, traffic, waiting, ga4Host });
  } catch {
    return emptyInterpretation(range);
  }
};
