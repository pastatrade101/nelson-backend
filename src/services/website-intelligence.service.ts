import {
  getDataStarts, getEventTimeseries, getFunnel, getOverview, type DataStarts, type ResolvedRange
} from './analytics.service';
import { getGa4LastHost, getTraffic, isGa4Configured, type Ga4LastHost, type Ga4Traffic } from './ga4.service';
import { getClarityInsights, type ClarityInsights } from './clarity.service';
import { buildInterpretation, type Interpretation } from './interpretation.service';

// ----------------------------------------------------------------------------
// Website Intelligence — a DETERMINISTIC rules engine. It turns the real
// analytics we already collect (first-party events + funnel, GA4 traffic,
// Clarity aggregates) into a health score, category scores, executive summary,
// rule-based alerts, prioritized improvement actions and a real event timeline,
// plus the plain-words interpretation of the main leads (interpretation.service).
// Every number is measured or transparently derived; missing data → null / N/A.
// Nothing is invented and no industry averages are used. Each executive card
// reads one source only: the in-house tracker, Bookings, or GA4 — never mixed.
// ----------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);
const pctChange = (cur: number, prev: number): number | null =>
  prev > 0 ? round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : prev === 0 && cur === 0 ? 0 : null;
// Transparent linear normalizer: value at/below `lo` → 0, at/above `hi` → 100.
const normalize = (v: number, lo: number, hi: number) => clamp(((v - lo) / (hi - lo)) * 100);
const rate = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

// A change on a previous figure under 5 says nothing: the card shows the two
// counts instead of a percentage.
const SMALL_BASE = 5;
// A funnel drop on fewer than this many people is noise, not a finding.
// A period this far through can be judged; before that, absences and falls are premature.
const SETTLED_SHARE = 0.9;
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM-DD' → '28 Sep'. */
const dayLabel = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

type Severity = 'critical' | 'warning' | 'info' | 'success';
type Priority = 'critical' | 'high' | 'medium' | 'low';
type Confidence = 'high' | 'medium' | 'low';
type Effort = 'easy' | 'medium' | 'hard';
type Category = 'Traffic' | 'Engagement' | 'Conversion' | 'User Experience' | 'Leads' | 'Booking Funnel' | 'Device Performance' | 'Page Performance';

/**
 * One executive card. `previous` is the same figure for the previous period
 * of equal length (null: unknown, or that period is from before the data
 * existed). `changePct` is null when previous is null or under 5, or when the
 * previous period only partly falls after the data began — the card then
 * shows "vs {previous}" instead of a percentage.
 */
export type MetricRef = {
  value: number | null; source: string; previous: number | null; changePct: number | null;
  status: 'direct' | 'derived' | 'na'; note?: string;
};
export type CategoryScore = { key: string; label: string; score: number | null; changePct: number | null; available: boolean; reason: string; basis: string };
export type Alert = { id: string; severity: Severity; category: Category; title: string; detail: string; metric: string | null; deepLink?: string };
export type Action = {
  id: string; priority: Priority; category: Category; issue: string; supportingMetric: string;
  why: string; fix: string; expectedOutcome: string; effort: Effort; confidence: Confidence; deepLink?: string;
};
export type TimelineEvent = { when: string; date: string; label: string; detail: string; direction: 'up' | 'down' | 'flat' };

export type WebsiteIntelligence = {
  generatedAt: string;
  range: { from: string; to: string; days: number; label: string };
  previousRange: { from: string; to: string };
  sources: { firstParty: boolean; ga4: boolean; clarity: boolean };
  health: { score: number | null; status: string; changePct: number | null; criticalCount: number; basis: string; contributing: string[] };
  categoryScores: CategoryScore[];
  executive: {
    metrics: Record<string, MetricRef>;
    /** Sessions left out of every in-house figure as automated traffic in this range. */
    automatedExcluded: number;
    biggestDropOff: string | null;
    topIssue: string | null;
  };
  alerts: Alert[];
  actions: Action[];
  timeline: TimelineEvent[];
  interpretation: Interpretation;
};

/** The previous period: the same length, ending where this one starts. */
const previousRange = (r: ResolvedRange): ResolvedRange => {
  const span = Date.parse(r.toIso) - Date.parse(r.fromIso);
  return { fromIso: new Date(Date.parse(r.fromIso) - span).toISOString(), toIso: r.fromIso, days: r.days };
};

/**
 * Where the previous period sits against the moment its data starts: wholly
 * before it ('none' — nothing was collected then), across it ('partial'), or
 * after it ('full'). An unknown start is taken as 'full'.
 */
const coverage = (start: string | null, prev: ResolvedRange): 'none' | 'partial' | 'full' => {
  const at = start ? Date.parse(start) : NaN;
  if (!Number.isFinite(at)) return 'full';
  if (Date.parse(prev.toIso) <= at) return 'none';
  return Date.parse(prev.fromIso) < at ? 'partial' : 'full';
};

/** % change against a previous figure, or null when it is unknown or under 5. */
const changeOf = (cur: number, prev: number | null): number | null =>
  prev === null || prev < SMALL_BASE ? null : round(((cur - prev) / prev) * 100);

const statusFor = (score: number): string =>
  score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';

const confidenceFor = (sample: number): Confidence => (sample >= 200 ? 'high' : sample >= 50 ? 'medium' : 'low');

type Overview = Awaited<ReturnType<typeof getOverview>>;
type Funnel = Awaited<ReturnType<typeof getFunnel>>;
type Drop = Funnel['drops'][number];

// What to do about the largest drop, by the pair of stages it sits between.
const DROP_ADVICE: Record<string, { why: string; fix: string }> = {
  'visitor>tour_view': {
    why: 'Most visitors leave without opening a single tour, so the tours never get the chance to sell.',
    fix: 'Feature tours on the pages people land on most, and keep a clear link to them in the menu.'
  },
  'tour_view>form_open': {
    why: 'People look at tours but do not open the enquiry form from them.',
    fix: 'Keep the enquiry button in view on every tour page, near the price and itinerary.'
  },
  'form_open>submitted': {
    why: 'People see or open an enquiry form but do not send it.',
    fix: 'Shorten the enquiry form and make clear which fields are required.'
  },
  'submitted>contacted': {
    why: "An enquiry counts as contacted only once its status in Bookings moves past 'pending'.",
    fix: 'Reply to each new enquiry and update its status in Bookings.'
  },
  'contacted>quoted': {
    why: "A contacted lead counts as quoted once its status shows the itinerary was sent.",
    fix: 'Send an itinerary and quote to contacted leads, and update the status in Bookings.'
  },
  'quoted>booked': {
    why: 'Quoted leads have not been confirmed as bookings.',
    fix: 'Follow up on sent quotes, and mark confirmed trips in Bookings.'
  }
};

export const getWebsiteIntelligence = async (range: ResolvedRange): Promise<WebsiteIntelligence> => {
  const prev = previousRange(range);
  const nowMs = Date.now();
  const fromMs = Date.parse(range.fromIso);
  const toMs = Date.parse(range.toIso);
  // How much of the range has passed (1 once it has ended).
  const elapsed = nowMs >= toMs ? 1 : Math.max(0, (nowMs - fromMs) / (toMs - fromMs));
  const settled = elapsed >= SETTLED_SHARE;

  // The interpretation reads the same overview, timeseries and GA4 traffic, so
  // it is handed these reads in flight and everything runs in parallel.
  const overviewRead = getOverview(range).catch(() => null);
  const timeseriesRead = getEventTimeseries(range).catch(() => null);
  const trafficRead = getTraffic(range).catch(() => null);
  const [overview, funnel, timeseries, overviewPrev, ga4, ga4Prev, clarity, starts, interpretation, ga4LastHost] = await Promise.all([
    overviewRead,
    getFunnel(range).catch(() => null),
    timeseriesRead,
    getOverview(prev).catch(() => null),
    trafficRead,
    getTraffic(prev).catch(() => null),
    getClarityInsights().catch(() => null),
    getDataStarts().catch((): DataStarts => ({ firstEventAt: null, firstPageViewAt: null, firstLeadAt: null })),
    buildInterpretation(range, { overview: overviewRead, timeseries: timeseriesRead, traffic: trafficRead }),
    getGa4LastHost().catch((): Ga4LastHost | null => null)
  ]);

  const o = overview?.ok ? overview : null;
  const op = overviewPrev?.ok ? overviewPrev : null;
  const f: Pick<Funnel, 'stages' | 'drops'> = funnel ?? { stages: [], drops: [] };
  const c = (clarity ?? null) as ClarityInsights | null;
  const cCfg = Boolean(c?.configured);
  const cError = cCfg ? c?.error ?? null : null;
  const ga4Cfg = isGa4Configured() && Boolean((ga4 as Ga4Traffic | null)?.configured);
  const firstParty = o !== null;

  const visitors = o?.visitors ?? 0;
  const pageViews = o?.pageViews ?? 0;
  const interactions = o?.interactions ?? 0;
  const activeVisitors = o?.activeVisitors ?? 0;
  const leads = o?.totalLeads ?? 0;
  const formOpens = o?.formOpens ?? 0;
  const formSubs = o?.formSubmissions ?? 0;
  const formOpenersWhoSent = o?.formOpenersWhoSent ?? 0;
  const whatsapp = o?.whatsappClicks ?? 0;
  const convRate = o?.leadConversionRate ?? 0;
  const formConvRate = o?.formConversionRate ?? 0;

  // ── previous period, only as far as the data behind each figure reaches ─────
  const visitsCover = coverage(starts.firstPageViewAt, prev);
  const eventsCover = coverage(starts.firstEventAt, prev);
  const leadsCover = coverage(starts.firstLeadAt, prev);
  const prevOf = (value: number | undefined, cover: ReturnType<typeof coverage>): number | null =>
    op && cover !== 'none' && value !== undefined ? value : null;
  // A period still in progress (it includes today) is compared with the same
  // share of the previous one: 57 visitors by 19:00 against a whole yesterday of
  // 87 is not a 34% fall. The base must still be 5 or more after scaling.
  const changeFor = (cur: number, previous: number | null, cover: ReturnType<typeof coverage>) =>
    cover === 'full' && previous !== null ? changeOf(cur, elapsed < 1 ? previous * elapsed : previous) : null;
  /** Said on a card while the period is well short of over. */
  const soFar = elapsed < SETTLED_SHARE ? `So far — ${Math.floor(elapsed * 100)}% of the period has passed` : undefined;

  const visitorsPrev = prevOf(op?.visitors, visitsCover);
  const leadsPrev = prevOf(op?.totalLeads, leadsCover);
  const convCover = visitsCover === 'none' || leadsCover === 'none' ? 'none' : visitsCover === 'full' && leadsCover === 'full' ? 'full' : 'partial';
  const convRatePrev = op && convCover !== 'none' && op.visitors > 0 ? op.leadConversionRate : null;
  // A rate moves on its smaller base: both the leads and the visitors behind it need 5 or more.
  const convSolid = convCover === 'full' && (leadsPrev ?? 0) >= SMALL_BASE && (visitorsPrev ?? 0) >= SMALL_BASE;
  const convChange = convSolid && convRatePrev !== null && convRatePrev > 0 ? round(((convRate - convRatePrev) / convRatePrev) * 100) : null;
  const visChange = changeFor(visitors, visitorsPrev, visitsCover);

  // ── biggest funnel drop-off (comparable stages, a base of 10 or more) ───────
  // Chosen once, by getFunnel, so the funnel's badge and this summary agree.
  const biggestDrop: Drop | null = funnel?.ok ? funnel.biggestDrop ?? null : null;
  const biggestDropPct = biggestDrop ? round(biggestDrop.dropPct ?? 0) : 0;
  const biggestDropOff = biggestDrop
    ? `${biggestDropPct}% drop · ${biggestDrop.fromLabel} → ${biggestDrop.toLabel} (${biggestDrop.fromValue} → ${biggestDrop.toValue})`
    : null;

  // ── Clarity friction rates (per session), only when export is live ──────────
  const cSessions = cCfg ? c!.totals.sessions ?? 0 : 0;
  const rageRate = cCfg && cSessions > 0 && c!.totals.rageClicks != null ? rate(c!.totals.rageClicks, cSessions) : null;
  const deadRate = cCfg && cSessions > 0 && c!.totals.deadClicks != null ? rate(c!.totals.deadClicks, cSessions) : null;
  const quickBackRate = cCfg && cSessions > 0 && c!.totals.quickBacks != null ? rate(c!.totals.quickBacks, cSessions) : null;
  const scrollDepth = cCfg ? c!.totals.avgScrollDepth : null;
  // Why a Clarity-based score is missing: not connected, or connected and failing.
  const clarityMissing = (what: string) =>
    cError ? `Clarity data export is connected but failed: ${cError}` : cCfg ? `Clarity returned no ${what} for the last 3 days.` : `Connect Clarity data export for ${what}.`;

  // ── category scores (transparent, disclosed; only where inputs exist) ───────
  const catScores: CategoryScore[] = [];
  // Conversion Health — visitor→lead (60%) + form openers who sent an enquiry (40%).
  const conversionScore = (lr: number, fr: number, opens: number) =>
    opens > 0 ? round(0.6 * normalize(lr, 0, 4) + 0.4 * normalize(fr, 0, 60)) : round(normalize(lr, 0, 4));
  if (firstParty && visitors > 0) {
    const s = conversionScore(convRate, formConvRate, formOpens);
    const sPrev = convSolid && op ? conversionScore(op.leadConversionRate, op.formConversionRate, op.formOpens) : null;
    catScores.push({ key: 'conversion', label: 'Conversion Health', score: s, changePct: sPrev != null ? pctChange(s, sPrev) : null, available: true,
      reason: formOpens > 0
        ? `Visitor→lead ${convRate}% · ${formConvRate}% of form openers sent an enquiry (${formOpenersWhoSent} of ${formOpens})`
        : `Visitor→lead ${convRate}% · no form opens tracked`,
      basis: 'Derived from website analytics' });
  } else {
    catScores.push({ key: 'conversion', label: 'Conversion Health', score: null, changePct: null, available: false,
      reason: firstParty ? 'No visitors recorded in this period yet.' : 'The in-house figures could not be read.', basis: 'Derived from website analytics' });
  }
  // Engagement Health — scroll depth (Clarity) + pages per visitor + share of visitors who interacted.
  if ((scrollDepth != null) || (firstParty && visitors > 0)) {
    const perVisitor = visitors > 0 ? pageViews / visitors : 0;
    const activeShare = rate(activeVisitors, visitors);
    const engParts: number[] = [];
    const reasons: string[] = [];
    if (scrollDepth != null) {
      engParts.push(normalize(scrollDepth, 20, 80));
      reasons.push(`Avg scroll ${round(scrollDepth)}%`);
    }
    if (firstParty && visitors > 0) {
      engParts.push(normalize(perVisitor, 1, 6), normalize(activeShare, 0, 20));
      reasons.push(`${perVisitor.toFixed(1)} pages/visitor`, `${activeShare.toFixed(1)}% of visitors interacted`);
    }
    const s = engParts.length ? round(engParts.reduce((a, b) => a + b, 0) / engParts.length) : null;
    catScores.push({ key: 'engagement', label: 'Engagement Health', score: s, changePct: null, available: s != null,
      reason: reasons.join(' · '), basis: 'Derived from website analytics' });
  } else {
    catScores.push({ key: 'engagement', label: 'Engagement Health', score: null, changePct: null, available: false, reason: 'Needs visitor activity or Clarity scroll data.', basis: 'Derived from website analytics' });
  }
  // UX Health — Clarity friction (rage/dead clicks). Needs Clarity export.
  if (rageRate != null || deadRate != null) {
    const penalty = (rageRate ?? 0) * 4 + (deadRate ?? 0) * 2; // each 1% of sessions costs points
    const s = round(clamp(100 - penalty));
    catScores.push({ key: 'ux', label: 'UX Health', score: s, changePct: null, available: true,
      reason: `${(rageRate ?? 0).toFixed(1)}% rage-click · ${(deadRate ?? 0).toFixed(1)}% dead-click sessions`, basis: 'Derived from website analytics' });
  } else {
    catScores.push({ key: 'ux', label: 'UX Health', score: null, changePct: null, available: false, reason: clarityMissing('friction signals'), basis: 'Derived from website analytics' });
  }
  // Traffic Quality — quick-back / bounce proxy (Clarity).
  if (quickBackRate != null) {
    const s = round(clamp(100 - quickBackRate));
    catScores.push({ key: 'traffic', label: 'Traffic Quality', score: s, changePct: null, available: true,
      reason: `${quickBackRate.toFixed(1)}% quick-back (bounce proxy)`, basis: 'Derived from website analytics' });
  } else {
    catScores.push({ key: 'traffic', label: 'Traffic Quality', score: null, changePct: null, available: false, reason: clarityMissing('bounce signals'), basis: 'Derived from website analytics' });
  }

  // ── overall health = mean of available category scores ──────────────────────
  const avail = catScores.filter((s) => s.score != null).map((s) => s.score as number);
  const healthScore = avail.length ? round(avail.reduce((a, b) => a + b, 0) / avail.length) : null;

  // ── alerts (rule-based on real conditions) ──────────────────────────────────
  // Absences, falls and form completion wait until 90% of the range has passed:
  // a day in progress cannot be judged, and enquiries arrive after the visit.
  const alerts: Alert[] = [];
  if (!ga4Cfg) alerts.push({ id: 'ga4-off', severity: 'info', category: 'Traffic', title: 'GA4 not connected', detail: 'Session, page-view and traffic-source data is unavailable until GA4 Data API credentials are set.', metric: null });
  if (!cCfg) alerts.push({ id: 'clarity-off', severity: 'info', category: 'User Experience', title: 'Clarity data export not connected', detail: 'Rage/dead-click, scroll and friction signals need the Clarity Data Export API token.', metric: null });
  else if (cError) alerts.push({ id: 'clarity-error', severity: 'info', category: 'User Experience', title: 'Clarity data export failed', detail: `The Clarity Data Export API token is set, but the request failed: ${cError}. Recordings are unaffected; friction and scroll figures return once the export answers.`, metric: null });
  if (settled && firstParty && visitors > 0 && leads === 0) alerts.push({ id: 'no-leads', severity: 'warning', category: 'Leads', title: 'No leads recorded this period', detail: `${visitors} visitors but 0 leads — check that CTAs and the enquiry form are reachable and working.`, metric: `${visitors} visitors · 0 leads` });
  if (settled && formOpens > 0 && formSubs === 0) alerts.push({ id: 'form-abandon', severity: 'critical', category: 'Conversion', title: 'Forms opened but never submitted', detail: `${formOpens} sessions opened an enquiry form and no enquiry arrived in Bookings — a likely form error or excessive friction is blocking completion.`, metric: `${formOpens} opens · 0 submits` });
  else if (settled && formOpens >= 10 && formConvRate < 20) alerts.push({ id: 'low-form-conv', severity: 'warning', category: 'Conversion', title: 'Few opened enquiry forms are sent', detail: `Only ${round(formConvRate)}% of the sessions seen opening an enquiry form sent one (${formOpenersWhoSent} of ${formOpens}; forms built into a page count as opened when they appear) — shorten the form or clarify required fields.`, metric: `${round(formConvRate)}% sent` });
  if (settled && visChange != null && visChange <= -30 && (visitorsPrev ?? 0) >= 20) alerts.push({ id: 'traffic-drop', severity: 'warning', category: 'Traffic', title: 'Sudden traffic decline', detail: `Visitors fell ${Math.abs(visChange)}% vs the previous period (${visitorsPrev} → ${visitors}).`, metric: `${visChange}% visitors` });
  if (settled && convChange != null && convChange <= -20) alerts.push({ id: 'conv-drop', severity: 'warning', category: 'Conversion', title: 'Conversion rate declining', detail: `Lead conversion dropped ${Math.abs(convChange)}% vs the previous period (${convRatePrev}% → ${convRate}%).`, metric: `${convChange}% conversion` });
  if (rageRate != null && rageRate >= 5) alerts.push({ id: 'rage', severity: 'warning', category: 'User Experience', title: 'High rage-click activity', detail: `${rageRate.toFixed(1)}% of sessions include rage clicks — investigate the elements users repeatedly click.`, metric: `${rageRate.toFixed(1)}% sessions`, deepLink: 'impressions' });
  if (deadRate != null && deadRate >= 5) alerts.push({ id: 'dead', severity: 'warning', category: 'User Experience', title: 'High dead-click activity', detail: `${deadRate.toFixed(1)}% of sessions include dead clicks — users click elements that do nothing.`, metric: `${deadRate.toFixed(1)}% sessions`, deepLink: 'impressions' });
  if (scrollDepth != null && scrollDepth < 40 && cSessions >= 30) alerts.push({ id: 'scroll', severity: 'warning', category: 'Engagement', title: 'Poor scroll depth', detail: `Average scroll depth is ${round(scrollDepth)}% — most visitors never reach lower-page content.`, metric: `${round(scrollDepth)}% avg scroll`, deepLink: 'heatmaps' });
  if (visChange != null && visChange >= 30 && (visitorsPrev ?? 0) >= 20) alerts.push({ id: 'traffic-up', severity: 'success', category: 'Traffic', title: 'Traffic increased', detail: `Visitors rose ${visChange}% vs the previous period (${visitorsPrev} → ${visitors}) — a good moment to double down on what's working.`, metric: `+${visChange}% visitors` });
  const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  // ── prioritized improvement actions (rule-based) ────────────────────────────
  const conf = confidenceFor(visitors || cSessions);
  const actions: Action[] = [];
  if (settled && formOpens > 0 && formSubs === 0) actions.push({ id: 'fix-form', priority: 'critical', category: 'Conversion', issue: 'Form submission failure', supportingMetric: `${formOpens} opens · 0 submissions`, why: 'Visitors are trying to enquire but none complete — this is direct lost lead volume.', fix: 'Test the enquiry form end-to-end; check validation, required fields and the submit handler.', expectedOutcome: 'Recover blocked lead submissions', effort: 'medium', confidence: conf });
  if (biggestDrop && biggestDropPct >= 60) {
    const advice = DROP_ADVICE[`${biggestDrop.from}>${biggestDrop.to}`];
    if (advice) actions.push({ id: 'dropoff', priority: 'high', category: 'Booking Funnel', issue: `Steep drop at ${biggestDrop.fromLabel} → ${biggestDrop.toLabel}`, supportingMetric: `${biggestDropPct}% drop (${biggestDrop.fromValue} → ${biggestDrop.toValue})`, why: advice.why, fix: advice.fix, expectedOutcome: 'Reduced funnel abandonment', effort: 'medium', confidence: confidenceFor(biggestDrop.fromValue) });
  }
  if (rageRate != null && rageRate >= 5) actions.push({ id: 'rage-fix', priority: 'high', category: 'User Experience', issue: 'Rage clicks on interactive elements', supportingMetric: `${rageRate.toFixed(1)}% of sessions`, why: 'Repeated clicking signals confusion or slow/broken responses, eroding trust.', fix: 'Open the Clarity recordings for rage-clicked pages and fix the unresponsive elements.', expectedOutcome: 'Reduced friction & abandonment', effort: 'medium', confidence: conf, deepLink: 'impressions' });
  if (scrollDepth != null && scrollDepth < 40 && cSessions >= 30) actions.push({ id: 'scroll-fix', priority: 'medium', category: 'Engagement', issue: 'Key content sits below the fold', supportingMetric: `${round(scrollDepth)}% avg scroll`, why: 'Most visitors leave before seeing lower sections, so CTAs there under-perform.', fix: 'Move primary CTAs and proof higher; tighten above-the-fold content.', expectedOutcome: 'Higher CTA engagement', effort: 'easy', confidence: conf, deepLink: 'heatmaps' });
  if (settled && whatsapp === 0 && visitors >= 30) actions.push({ id: 'wa-cta', priority: 'medium', category: 'Conversion', issue: 'WhatsApp CTA getting no clicks', supportingMetric: `0 clicks · ${visitors} visitors`, why: 'WhatsApp is the fastest booking path for this audience but it is being missed.', fix: 'Raise the WhatsApp CTA visibility (sticky/above-the-fold) and label it clearly.', expectedOutcome: 'Higher CTA engagement', effort: 'easy', confidence: conf });
  if (settled && formOpens >= 10 && formSubs > 0 && formConvRate < 30) actions.push({ id: 'form-len', priority: 'medium', category: 'Conversion', issue: 'Few opened enquiry forms are sent', supportingMetric: `${round(formConvRate)}% sent (${formOpenersWhoSent} of ${formOpens} sessions)`, why: 'Long or unclear forms lose people who were ready to enquire.', fix: 'Reduce required fields and split into clear steps.', expectedOutcome: 'Improved form completion', effort: 'easy', confidence: confidenceFor(formOpens) });
  if (deadRate != null && deadRate >= 5) actions.push({ id: 'dead-fix', priority: 'low', category: 'User Experience', issue: 'Dead clicks on non-interactive elements', supportingMetric: `${deadRate.toFixed(1)}% of sessions`, why: 'Users expect these elements to do something — a small affordance fix helps.', fix: 'Make clicked-but-static elements interactive, or remove the affordance.', expectedOutcome: 'Reduced confusion', effort: 'easy', confidence: conf, deepLink: 'impressions' });
  const prioRank: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => prioRank[a.priority] - prioRank[b.priority]);

  // ── real event timeline (notable day-over-day changes in real visitors) ─────
  const timeline: TimelineEvent[] = [];
  const byDay = (timeseries?.byDay ?? []) as Array<{ date: string; visitors: number; events: number; whatsapp: number }>;
  if (byDay.length >= 3) {
    const vals = byDay.map((d) => d.visitors);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    byDay.forEach((d, i) => {
      if (i === 0 || mean < 3) return;
      const prevV = byDay[i - 1].visitors;
      const ch = pctChange(d.visitors, prevV);
      if (ch != null && Math.abs(ch) >= 50 && Math.max(d.visitors, prevV) >= Math.max(5, mean)) {
        timeline.push({ when: d.date, date: d.date, label: ch > 0 ? `Traffic spiked ${ch}%` : `Traffic fell ${Math.abs(ch)}%`, detail: `${prevV} → ${d.visitors} visitors`, direction: ch > 0 ? 'up' : 'down' });
      }
    });
  }
  // period-level markers (real, from prev-vs-current; falls only once the range has settled)
  if (visChange != null && Math.abs(visChange) >= 15 && (visitorsPrev ?? 0) >= 10 && (visChange > 0 || settled)) timeline.push({ when: 'This period', date: range.toIso.slice(0, 10), label: `Visitors ${visChange > 0 ? 'up' : 'down'} ${Math.abs(visChange)}% vs previous`, detail: `${visitorsPrev} → ${visitors}`, direction: visChange > 0 ? 'up' : 'down' });
  if (convChange != null && Math.abs(convChange) >= 15 && (convChange > 0 || settled)) timeline.push({ when: 'This period', date: range.toIso.slice(0, 10), label: `Conversion ${convChange > 0 ? 'up' : 'down'} ${Math.abs(convChange)}% vs previous`, detail: `${convRatePrev}% → ${convRate}%`, direction: convChange > 0 ? 'up' : 'down' });
  timeline.sort((a, b) => b.date.localeCompare(a.date));

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const topIssue = actions[0]?.issue ?? alerts.find((a) => a.severity === 'critical' || a.severity === 'warning')?.title ?? null;

  // ── GA4 visitors: its own card, never mixed with the in-house figures ───────
  const g = ga4Cfg ? (ga4 as Ga4Traffic) : null;
  const gPrev = ga4Cfg && ga4Prev && !ga4Prev.error ? ga4Prev : null;
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const lastWholeDay = new Date(Math.min(Date.parse(today), toMs) - DAY_MS).toISOString().slice(0, 10);
  const lastGa4DayInRange = [...(g?.byDay ?? [])].reverse().find((d) => d.users > 0)?.date ?? null;
  // GA4's last day with any visit at all (90 days back), so a short range that
  // fell entirely inside the gap still knows GA4 has gone quiet.
  const lastGa4Day = ga4LastHost?.date ?? lastGa4DayInRange;
  const yesterday = new Date(Date.parse(today) - DAY_MS).toISOString().slice(0, 10);
  // Three or more whole days without a GA4 visitor is a gap, not GA4's usual delay.
  const ga4Silent = Boolean(g && !g.error) && (lastGa4Day
    ? (Date.parse(yesterday) - Date.parse(lastGa4Day)) / DAY_MS >= 3
    : (Date.parse(lastWholeDay) - (fromMs - DAY_MS)) / DAY_MS >= 3);
  const ga4Ref = (): MetricRef => {
    if (!g) return { value: null, source: 'ga4', previous: null, changePct: null, status: 'na', note: 'Connect GA4' };
    if (g.error) return { value: null, source: 'ga4', previous: null, changePct: null, status: 'na', note: `GA4 read failed: ${g.error.slice(0, 140)}` };
    const previous = gPrev ? gPrev.totalUsers : null;
    return {
      value: g.totalUsers, source: 'ga4', previous,
      // A period GA4 stopped counting part-way through is no basis for a % change.
      changePct: ga4Silent ? null : changeOf(g.totalUsers, previous),
      status: 'direct',
      note: ga4Silent
        ? lastGa4Day
          ? `GA4 has counted no visitors since ${dayLabel(lastGa4Day)}${ga4LastHost?.host ? ` (last from ${ga4LastHost.host})` : ''}`
          : 'GA4 has counted no visitors in this period'
        : 'Visitors who accepted cookies'
    };
  };

  const inHouse = (value: number, source: string, previous: number | null, changePct: number | null, status: MetricRef['status'] = 'direct'): MetricRef =>
    firstParty
      ? { value, source, previous, changePct, status, ...(soFar && status === 'direct' ? { note: soFar } : {}) }
      : { value: null, source, previous: null, changePct: null, status: 'na', note: 'In-house figures could not be read' };
  const count = (key: 'visitors' | 'pageViews' | 'interactions' | 'totalLeads' | 'formOpens' | 'formSubmissions' | 'itineraryRequests' | 'whatsappClicks', cover: ReturnType<typeof coverage>) => {
    const previous = prevOf(op?.[key], cover);
    return { previous, changePct: changeFor(o?.[key] ?? 0, previous, cover) };
  };
  const m = {
    visitors: count('visitors', visitsCover),
    pageViews: count('pageViews', visitsCover),
    interactions: count('interactions', eventsCover),
    leads: count('totalLeads', leadsCover),
    formOpens: count('formOpens', eventsCover),
    formSubmissions: count('formSubmissions', leadsCover),
    itineraryRequests: count('itineraryRequests', leadsCover),
    whatsappClicks: count('whatsappClicks', eventsCover)
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    range: { from: range.fromIso, to: range.toIso, days: range.days, label: `${range.days}-day` },
    previousRange: { from: prev.fromIso, to: prev.toIso },
    sources: { firstParty, ga4: ga4Cfg, clarity: cCfg },
    health: {
      score: healthScore,
      status: healthScore != null ? statusFor(healthScore) : 'N/A',
      changePct: null,
      criticalCount,
      basis: 'Derived from website analytics',
      contributing: catScores.filter((s) => s.score != null).map((s) => s.label)
    },
    categoryScores: catScores,
    executive: {
      metrics: {
        // In-house tracker: real visitors (sessions with a page view), automated networks out.
        visitors: inHouse(visitors, 'website', m.visitors.previous, m.visitors.changePct),
        pageViews: inHouse(pageViews, 'website', m.pageViews.previous, m.pageViews.changePct),
        // GA4: visitors who accepted cookies (GA4 loads only after consent).
        ga4Visitors: ga4Ref(),
        interactions: inHouse(interactions, 'website', m.interactions.previous, m.interactions.changePct),
        // Bookings: the website's enquiries.
        leads: inHouse(leads, 'website', m.leads.previous, m.leads.changePct),
        conversionRate: inHouse(convRate, 'website', convRatePrev, convChange, 'derived'),
        formOpens: inHouse(formOpens, 'website', m.formOpens.previous, m.formOpens.changePct),
        formSubmissions: inHouse(formSubs, 'website', m.formSubmissions.previous, m.formSubmissions.changePct),
        itineraryRequests: inHouse(o?.itineraryRequests ?? 0, 'website', m.itineraryRequests.previous, m.itineraryRequests.changePct),
        whatsappClicks: inHouse(whatsapp, 'website', m.whatsappClicks.previous, m.whatsappClicks.changePct)
      },
      automatedExcluded: o?.automatedExcluded ?? 0,
      biggestDropOff,
      topIssue
    },
    alerts,
    actions,
    timeline: timeline.slice(0, 8),
    interpretation
  };
};
