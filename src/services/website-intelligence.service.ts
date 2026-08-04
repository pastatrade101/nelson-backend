import {
  getEventTimeseries, getFunnel, getOverview, resolveRange, type ResolvedRange
} from './analytics.service';
import { getTraffic, isGa4Configured } from './ga4.service';
import { getClarityInsights, isClarityConfigured, type ClarityInsights } from './clarity.service';

// ----------------------------------------------------------------------------
// Website Intelligence — a DETERMINISTIC rules engine (no LLM). It turns the
// real analytics we already collect (first-party events + funnel, GA4 traffic,
// Clarity aggregates) into a health score, category scores, executive summary,
// rule-based alerts, prioritized improvement actions and a real event timeline.
// Every number is measured or transparently derived; missing data → null / N/A.
// Nothing is invented and no industry averages are used.
// ----------------------------------------------------------------------------

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const round = (n: number) => Math.round(n);
const pctChange = (cur: number, prev: number): number | null =>
  prev > 0 ? round(((cur - prev) / prev) * 100) : cur > 0 ? 100 : prev === 0 && cur === 0 ? 0 : null;
// Transparent linear normalizer: value at/below `lo` → 0, at/above `hi` → 100.
const normalize = (v: number, lo: number, hi: number) => clamp(((v - lo) / (hi - lo)) * 100);
const rate = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);

type Severity = 'critical' | 'warning' | 'info' | 'success';
type Priority = 'critical' | 'high' | 'medium' | 'low';
type Confidence = 'high' | 'medium' | 'low';
type Effort = 'easy' | 'medium' | 'hard';
type Category = 'Traffic' | 'Engagement' | 'Conversion' | 'User Experience' | 'Leads' | 'Booking Funnel' | 'Device Performance' | 'Page Performance';

export type MetricRef = { value: number | null; source: string; changePct: number | null; status: 'direct' | 'derived' | 'na'; note?: string };
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
  executive: { metrics: Record<string, MetricRef>; biggestDropOff: string | null; topIssue: string | null };
  alerts: Alert[];
  actions: Action[];
  timeline: TimelineEvent[];
};

const previousRange = (r: ResolvedRange): ResolvedRange => {
  const from = new Date(r.fromIso);
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (r.days - 1) * 86_400_000);
  return { fromIso: prevFrom.toISOString(), toIso: prevTo.toISOString(), days: r.days };
};

const statusFor = (score: number): string =>
  score >= 85 ? 'Excellent' : score >= 70 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';

const confidenceFor = (sample: number): Confidence => (sample >= 200 ? 'high' : sample >= 50 ? 'medium' : 'low');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OverviewShape = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FunnelShape = any;

export const getWebsiteIntelligence = async (range: ResolvedRange): Promise<WebsiteIntelligence> => {
  const prev = previousRange(range);
  const [overview, funnel, timeseries, overviewPrev, funnelPrev, ga4, clarity] = await Promise.all([
    getOverview(range).catch(() => null),
    getFunnel(range).catch(() => null),
    getEventTimeseries(range).catch(() => null),
    getOverview(prev).catch(() => null),
    getFunnel(prev).catch(() => null),
    getTraffic(range).catch(() => null),
    getClarityInsights().catch(() => null)
  ]);

  const o = (overview ?? {}) as OverviewShape;
  const op = (overviewPrev ?? {}) as OverviewShape;
  const f = (funnel ?? { stages: [], rates: {} }) as FunnelShape;
  const c = (clarity ?? null) as ClarityInsights | null;
  const cCfg = Boolean(c?.configured);
  const ga4Cfg = isGa4Configured() && Boolean((ga4 as { configured?: boolean } | null)?.configured);
  const firstParty = Boolean(overview);

  const num = (obj: OverviewShape, key: string): number => Number(obj?.[key] ?? 0);
  const visitors = num(o, 'visitors');
  const visitorsPrev = num(op, 'visitors');
  const interactions = num(o, 'interactions');
  const leads = num(o, 'totalLeads');
  const leadsPrev = num(op, 'totalLeads');
  const formOpens = num(o, 'formOpens');
  const formSubs = num(o, 'planMyTripSubmissions') + num(o, 'requestTripSubmissions');
  const bookingRequests = num(o, 'requestTripSubmissions');
  const whatsapp = num(o, 'whatsappClicks');
  const convRate = num(o, 'leadConversionRate');
  const convRatePrev = num(op, 'leadConversionRate');
  const formConvRate = num(o, 'formConversionRate');

  // ── biggest funnel drop-off (real stage values) ─────────────────────────────
  const stages = (f.stages ?? []) as Array<{ key: string; label: string; value: number }>;
  let biggestDrop: { from: string; to: string; pct: number } | null = null;
  for (let i = 0; i < stages.length - 1; i++) {
    const a = stages[i], b = stages[i + 1];
    if (a.value > 0) {
      const dropPct = round(((a.value - b.value) / a.value) * 100);
      if (dropPct > 0 && (!biggestDrop || dropPct > biggestDrop.pct)) biggestDrop = { from: a.label, to: b.label, pct: dropPct };
    }
  }
  const biggestDropOff = biggestDrop ? `${biggestDrop.pct}% drop · ${biggestDrop.from} → ${biggestDrop.to}` : null;

  // ── Clarity friction rates (per session), only when export is live ──────────
  const cSessions = cCfg ? c!.totals.sessions ?? 0 : 0;
  const rageRate = cCfg && cSessions > 0 && c!.totals.rageClicks != null ? rate(c!.totals.rageClicks, cSessions) : null;
  const deadRate = cCfg && cSessions > 0 && c!.totals.deadClicks != null ? rate(c!.totals.deadClicks, cSessions) : null;
  const quickBackRate = cCfg && cSessions > 0 && c!.totals.quickBacks != null ? rate(c!.totals.quickBacks, cSessions) : null;
  const scrollDepth = cCfg ? c!.totals.avgScrollDepth : null;

  // ── category scores (transparent, disclosed; only where inputs exist) ───────
  const catScores: CategoryScore[] = [];
  // Conversion Health — visitor→lead + form completion (first-party, direct).
  if (firstParty && visitors > 0) {
    const s = round(0.6 * normalize(convRate, 0, 4) + 0.4 * normalize(formConvRate, 0, 60));
    const sPrev = visitorsPrev > 0 ? round(normalize(convRatePrev, 0, 4)) : null;
    catScores.push({ key: 'conversion', label: 'Conversion Health', score: s, changePct: sPrev != null ? pctChange(s, sPrev) : null, available: true,
      reason: `Visitor→lead ${convRate}% · form completion ${formConvRate}%`, basis: 'Derived from website analytics' });
  } else {
    catScores.push({ key: 'conversion', label: 'Conversion Health', score: null, changePct: null, available: false, reason: 'No visitors recorded in this period yet.', basis: 'Derived from website analytics' });
  }
  // Engagement Health — scroll depth (Clarity) + interactions per visitor.
  if ((scrollDepth != null) || (firstParty && visitors > 0)) {
    const perVisitor = visitors > 0 ? interactions / visitors : 0;
    const engParts: number[] = [];
    if (scrollDepth != null) engParts.push(normalize(scrollDepth, 20, 80));
    if (firstParty && visitors > 0) engParts.push(normalize(perVisitor, 1, 6));
    const s = engParts.length ? round(engParts.reduce((a, b) => a + b, 0) / engParts.length) : null;
    catScores.push({ key: 'engagement', label: 'Engagement Health', score: s, changePct: null, available: s != null,
      reason: scrollDepth != null ? `Avg scroll ${round(scrollDepth)}% · ${perVisitor.toFixed(1)} interactions/visitor` : `${perVisitor.toFixed(1)} interactions/visitor`,
      basis: 'Derived from website analytics' });
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
    catScores.push({ key: 'ux', label: 'UX Health', score: null, changePct: null, available: false, reason: 'Connect Clarity data export for friction signals.', basis: 'Derived from website analytics' });
  }
  // Traffic Quality — quick-back / bounce proxy (Clarity).
  if (quickBackRate != null) {
    const s = round(clamp(100 - quickBackRate));
    catScores.push({ key: 'traffic', label: 'Traffic Quality', score: s, changePct: null, available: true,
      reason: `${quickBackRate.toFixed(1)}% quick-back (bounce proxy)`, basis: 'Derived from website analytics' });
  } else {
    catScores.push({ key: 'traffic', label: 'Traffic Quality', score: null, changePct: null, available: false, reason: 'Connect Clarity data export for bounce signals.', basis: 'Derived from website analytics' });
  }

  // ── overall health = mean of available category scores ──────────────────────
  const avail = catScores.filter((s) => s.score != null).map((s) => s.score as number);
  const healthScore = avail.length ? round(avail.reduce((a, b) => a + b, 0) / avail.length) : null;

  // ── alerts (rule-based on real conditions) ──────────────────────────────────
  const alerts: Alert[] = [];
  if (!ga4Cfg) alerts.push({ id: 'ga4-off', severity: 'info', category: 'Traffic', title: 'GA4 not connected', detail: 'Session, page-view and traffic-source data is unavailable until GA4 Data API credentials are set.', metric: null });
  if (!cCfg) alerts.push({ id: 'clarity-off', severity: 'info', category: 'User Experience', title: 'Clarity data export not connected', detail: 'Rage/dead-click, scroll and friction signals need the Clarity Data Export API token.', metric: null });
  if (firstParty && visitors > 0 && leads === 0) alerts.push({ id: 'no-leads', severity: 'warning', category: 'Leads', title: 'No leads recorded this period', detail: `${visitors} visitors but 0 leads — check that CTAs and the enquiry form are reachable and working.`, metric: `${visitors} visitors · 0 leads` });
  if (formOpens > 0 && formSubs === 0) alerts.push({ id: 'form-abandon', severity: 'critical', category: 'Conversion', title: 'Forms opened but never submitted', detail: `${formOpens} form opens with 0 submissions — a likely form error or excessive friction is blocking completion.`, metric: `${formOpens} opens · 0 submits` });
  else if (formOpens >= 10 && rate(formSubs, formOpens) < 20) alerts.push({ id: 'low-form-conv', severity: 'warning', category: 'Conversion', title: 'Low form completion rate', detail: `Only ${round(rate(formSubs, formOpens))}% of opened forms are submitted — shorten the form or clarify required fields.`, metric: `${round(rate(formSubs, formOpens))}% completion` });
  const visChange = pctChange(visitors, visitorsPrev);
  if (visChange != null && visChange <= -30 && visitorsPrev >= 20) alerts.push({ id: 'traffic-drop', severity: 'warning', category: 'Traffic', title: 'Sudden traffic decline', detail: `Visitors fell ${Math.abs(visChange)}% vs the previous period (${visitorsPrev} → ${visitors}).`, metric: `${visChange}% visitors` });
  const convChange = pctChange(convRate, convRatePrev);
  if (convChange != null && convChange <= -20 && leadsPrev > 0) alerts.push({ id: 'conv-drop', severity: 'warning', category: 'Conversion', title: 'Conversion rate declining', detail: `Lead conversion dropped ${Math.abs(convChange)}% vs the previous period.`, metric: `${convChange}% conversion` });
  if (rageRate != null && rageRate >= 5) alerts.push({ id: 'rage', severity: 'warning', category: 'User Experience', title: 'High rage-click activity', detail: `${rageRate.toFixed(1)}% of sessions include rage clicks — investigate the elements users repeatedly click.`, metric: `${rageRate.toFixed(1)}% sessions`, deepLink: 'impressions' });
  if (deadRate != null && deadRate >= 5) alerts.push({ id: 'dead', severity: 'warning', category: 'User Experience', title: 'High dead-click activity', detail: `${deadRate.toFixed(1)}% of sessions include dead clicks — users click elements that do nothing.`, metric: `${deadRate.toFixed(1)}% sessions`, deepLink: 'impressions' });
  if (scrollDepth != null && scrollDepth < 40 && cSessions >= 30) alerts.push({ id: 'scroll', severity: 'warning', category: 'Engagement', title: 'Poor scroll depth', detail: `Average scroll depth is ${round(scrollDepth)}% — most visitors never reach lower-page content.`, metric: `${round(scrollDepth)}% avg scroll`, deepLink: 'heatmaps' });
  if (visChange != null && visChange >= 30 && visitorsPrev >= 20) alerts.push({ id: 'traffic-up', severity: 'success', category: 'Traffic', title: 'Traffic increased', detail: `Visitors rose ${visChange}% vs the previous period — a good moment to double down on what's working.`, metric: `+${visChange}% visitors` });
  const sevRank: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  // ── prioritized improvement actions (rule-based) ────────────────────────────
  const conf = confidenceFor(visitors || cSessions);
  const actions: Action[] = [];
  if (formOpens > 0 && formSubs === 0) actions.push({ id: 'fix-form', priority: 'critical', category: 'Conversion', issue: 'Form submission failure', supportingMetric: `${formOpens} opens · 0 submissions`, why: 'Visitors are trying to enquire but none complete — this is direct lost lead volume.', fix: 'Test the enquiry form end-to-end; check validation, required fields and the submit handler.', expectedOutcome: 'Recover blocked lead submissions', effort: 'medium', confidence: conf });
  if (biggestDrop && biggestDrop.pct >= 60 && biggestDrop.from !== 'Booked') actions.push({ id: 'dropoff', priority: 'high', category: 'Booking Funnel', issue: `Steep drop at ${biggestDrop.from} → ${biggestDrop.to}`, supportingMetric: `${biggestDrop.pct}% drop`, why: 'The largest funnel leak is here — fixing it lifts everything downstream.', fix: `Review the ${biggestDrop.to.toLowerCase()} step for friction, clarity and load speed.`, expectedOutcome: 'Reduced funnel abandonment', effort: 'medium', confidence: conf });
  if (rageRate != null && rageRate >= 5) actions.push({ id: 'rage-fix', priority: 'high', category: 'User Experience', issue: 'Rage clicks on interactive elements', supportingMetric: `${rageRate.toFixed(1)}% of sessions`, why: 'Repeated clicking signals confusion or slow/broken responses, eroding trust.', fix: 'Open the Clarity recordings for rage-clicked pages and fix the unresponsive elements.', expectedOutcome: 'Reduced friction & abandonment', effort: 'medium', confidence: conf, deepLink: 'impressions' });
  if (scrollDepth != null && scrollDepth < 40 && cSessions >= 30) actions.push({ id: 'scroll-fix', priority: 'medium', category: 'Engagement', issue: 'Key content sits below the fold', supportingMetric: `${round(scrollDepth)}% avg scroll`, why: 'Most visitors leave before seeing lower sections, so CTAs there under-perform.', fix: 'Move primary CTAs and proof higher; tighten above-the-fold content.', expectedOutcome: 'Higher CTA engagement', effort: 'easy', confidence: conf, deepLink: 'heatmaps' });
  if (whatsapp === 0 && visitors >= 30) actions.push({ id: 'wa-cta', priority: 'medium', category: 'Conversion', issue: 'WhatsApp CTA getting no clicks', supportingMetric: `0 clicks · ${visitors} visitors`, why: 'WhatsApp is the fastest booking path for this audience but it is being missed.', fix: 'Raise the WhatsApp CTA visibility (sticky/above-the-fold) and label it clearly.', expectedOutcome: 'Higher CTA engagement', effort: 'easy', confidence: conf });
  if (formOpens >= 10 && formSubs > 0 && rate(formSubs, formOpens) < 30) actions.push({ id: 'form-len', priority: 'medium', category: 'Conversion', issue: 'Form completion is low', supportingMetric: `${round(rate(formSubs, formOpens))}% completion`, why: 'Long or unclear forms lose people who were ready to enquire.', fix: 'Reduce required fields and split into clear steps.', expectedOutcome: 'Improved form completion', effort: 'easy', confidence: conf });
  if (deadRate != null && deadRate >= 5) actions.push({ id: 'dead-fix', priority: 'low', category: 'User Experience', issue: 'Dead clicks on non-interactive elements', supportingMetric: `${deadRate.toFixed(1)}% of sessions`, why: 'Users expect these elements to do something — a small affordance fix helps.', fix: 'Make clicked-but-static elements interactive, or remove the affordance.', expectedOutcome: 'Reduced confusion', effort: 'easy', confidence: conf, deepLink: 'impressions' });
  const prioRank: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  actions.sort((a, b) => prioRank[a.priority] - prioRank[b.priority]);

  // ── real event timeline (notable day-over-day changes) ──────────────────────
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
  // period-level markers (real, from prev-vs-current)
  if (visChange != null && Math.abs(visChange) >= 15 && visitorsPrev >= 10) timeline.push({ when: 'This period', date: range.toIso.slice(0, 10), label: `Visitors ${visChange > 0 ? 'up' : 'down'} ${Math.abs(visChange)}% vs previous`, detail: `${visitorsPrev} → ${visitors}`, direction: visChange > 0 ? 'up' : 'down' });
  if (convChange != null && Math.abs(convChange) >= 15 && leadsPrev > 0) timeline.push({ when: 'This period', date: range.toIso.slice(0, 10), label: `Conversion ${convChange > 0 ? 'up' : 'down'} ${Math.abs(convChange)}% vs previous`, detail: `${convRatePrev}% → ${convRate}%`, direction: convChange > 0 ? 'up' : 'down' });
  timeline.sort((a, b) => b.date.localeCompare(a.date));

  const criticalCount = alerts.filter((a) => a.severity === 'critical').length;
  const topIssue = actions[0]?.issue ?? alerts.find((a) => a.severity === 'critical' || a.severity === 'warning')?.title ?? null;

  const ref = (value: number | null, source: string, change: number | null, status: MetricRef['status'], note?: string): MetricRef => ({ value, source, changePct: change, status, note });
  const ga4Sessions = ga4Cfg ? Number((ga4 as { sessions?: number }).sessions ?? 0) : null;
  const ga4Views = ga4Cfg ? Number((ga4 as { pageViews?: number }).pageViews ?? 0) : null;

  return {
    generatedAt: new Date().toISOString(),
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
        visitors: ref(firstParty ? visitors : null, 'website', pctChange(visitors, visitorsPrev), 'direct'),
        sessions: ref(ga4Sessions, 'ga4', null, ga4Cfg ? 'direct' : 'na', ga4Cfg ? undefined : 'Connect GA4'),
        pageViews: ref(ga4Views, 'ga4', null, ga4Cfg ? 'direct' : 'na', ga4Cfg ? undefined : 'Connect GA4'),
        interactions: ref(firstParty ? interactions : null, 'website', null, 'direct'),
        leads: ref(firstParty ? leads : null, 'makutano', pctChange(leads, leadsPrev), 'direct'),
        conversionRate: ref(firstParty ? convRate : null, 'makutano', pctChange(convRate, convRatePrev), 'derived'),
        formOpens: ref(firstParty ? formOpens : null, 'website', null, 'direct'),
        formSubmissions: ref(firstParty ? formSubs : null, 'website', null, 'direct'),
        bookingRequests: ref(firstParty ? bookingRequests : null, 'makutano', null, 'direct'),
        whatsappClicks: ref(firstParty ? whatsapp : null, 'website', null, 'direct')
      },
      biggestDropOff,
      topIssue
    },
    alerts,
    actions,
    timeline: timeline.slice(0, 8)
  };
};
