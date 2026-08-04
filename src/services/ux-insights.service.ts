import { env } from '../config/env';
import { createMessage, isAnthropicConfigured } from './anthropic.service';
import { getClarityInsights, isClarityConfigured, type ClarityInsights } from './clarity.service';
import { getTraffic, isGa4Configured } from './ga4.service';
import { getFunnel, getOverview, type ResolvedRange } from './analytics.service';

// ----------------------------------------------------------------------------
// AI analyst summary — a grounded executive narrative + supporting recommendations
// generated STRICTLY from the real metrics we already hold (Clarity + GA4 +
// first-party). It complements (does not replace) the deterministic engine. The
// model is told never to invent numbers; if there isn't enough real signal, or
// Anthropic isn't configured, we return an honest "not available yet" state.
// Cached to control cost. This is a supporting layer — NOT a chat/assistant.
// ----------------------------------------------------------------------------

export type UxInsight = {
  id: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  title: string;
  why: string;
  impact: string;
  difficulty: 'easy' | 'medium' | 'hard';
  estTime: string;
  source: string;
};

export type UxInsightsResult = {
  available: boolean;
  reason?: string;
  generatedAt: string | null;
  summary: string | null;
  insights: UxInsight[];
  dataSources: string[];
};

const NOT_AVAILABLE = (reason: string): UxInsightsResult => ({
  available: false, reason, generatedAt: null, summary: null, insights: [], dataSources: []
});

const extractJson = <T>(text: string): T | null => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
};

const PRIORITY = new Set(['critical', 'high', 'medium', 'low']);
const CONFIDENCE = new Set(['high', 'medium', 'low']);
const DIFFICULTY = new Set(['easy', 'medium', 'hard']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const normInsight = (x: any, i: number): UxInsight | null => {
  if (!x || typeof x !== 'object') return null;
  const title = String(x.title ?? '').trim();
  const why = String(x.why ?? '').trim();
  if (!title || !why) return null;
  const priority = PRIORITY.has(x.priority) ? x.priority : 'medium';
  const confidence = CONFIDENCE.has(x.confidence) ? x.confidence : 'medium';
  const difficulty = DIFFICULTY.has(x.difficulty) ? x.difficulty : 'medium';
  return {
    id: `ux-${i}`,
    priority, confidence, difficulty,
    title: title.slice(0, 120),
    why: why.slice(0, 400),
    impact: String(x.impact ?? '').trim().slice(0, 80) || 'Not estimated',
    estTime: String(x.estTime ?? x.est_time ?? '').trim().slice(0, 40) || 'Unknown',
    source: String(x.source ?? '').trim().slice(0, 60) || 'Website analytics'
  };
};

const PRIORITY_RANK: Record<UxInsight['priority'], number> = { critical: 0, high: 1, medium: 2, low: 3 };

const hasSignal = (c: ClarityInsights, ga4Sessions: number, businessEvents: number, leads: number): boolean =>
  (c.configured && (c.totals.sessions ?? 0) > 0) || ga4Sessions > 0 || businessEvents > 5 || leads > 0;

const SYSTEM =
  'You are a senior website analytics and conversion-rate-optimization analyst for Emnel Adventures, a ' +
  'premium private Tanzania safari company. You are given REAL analytics metrics from multiple sources. ' +
  'Produce a concise executive website summary and prioritized, actionable recommendations for a small ' +
  'luxury-travel team. STRICT RULES: (1) Use ONLY the numbers provided — never invent metrics, pages, ' +
  'percentages or events. (2) If a number is null/absent, do not reference it. (3) Every recommendation ' +
  'must explain WHY the data implies it (interpret the numbers, do not just restate them). (4) Be honest ' +
  'about confidence — if evidence is thin, say confidence is low. (5) Keep everything in website terms ' +
  '(traffic, engagement, conversion, leads, funnel); do NOT estimate revenue. Reply with STRICT JSON ' +
  'only, no prose outside the JSON.';

const promptFor = (metrics: Record<string, unknown>): string =>
  'Here are the real, current website metrics (JSON). Some sources may be unconfigured (null) — ignore those.\n\n' +
  `${JSON.stringify(metrics, null, 2)}\n\n` +
  'Return STRICT JSON with this exact shape:\n' +
  '{\n' +
  '  "summary": "2-3 sentence executive website summary grounded in the numbers above",\n' +
  '  "insights": [\n' +
  '    {\n' +
  '      "title": "short imperative recommendation",\n' +
  '      "why": "what the numbers mean and why this matters (interpretation, not restatement)",\n' +
  '      "priority": "critical|high|medium|low",\n' +
  '      "confidence": "high|medium|low",\n' +
  '      "impact": "website-terms estimate e.g. \'Higher form completion\' or \'Reduced abandonment\'",\n' +
  '      "difficulty": "easy|medium|hard",\n' +
  '      "estTime": "e.g. \'30 minutes\', \'Half a day\'",\n' +
  '      "source": "which data source(s) support this, e.g. \'Microsoft Clarity + first-party\'"\n' +
  '    }\n' +
  '  ]\n' +
  '}\n' +
  'Provide 3-6 insights, ordered most-critical first. If evidence is genuinely thin, return fewer ' +
  'insights with low confidence rather than padding.';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; data: UxInsightsResult }>();

/** Grounded AI analyst summary + recommendations. Never throws. */
export const getUxInsights = async (range: ResolvedRange, force = false): Promise<UxInsightsResult> => {
  const key = `${range.fromIso}|${range.toIso}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  if (!isAnthropicConfigured()) {
    return NOT_AVAILABLE('AI analysis is not configured (set ANTHROPIC_API_KEY) — the deterministic metrics above are unaffected.');
  }

  const [clarity, ga4, overview, funnel] = await Promise.all([
    getClarityInsights().catch(() => null),
    getTraffic(range).catch(() => null),
    getOverview(range).catch(() => null),
    getFunnel(range).catch(() => null)
  ]);

  const c = (clarity ?? { configured: false, totals: {} }) as ClarityInsights;
  const ga4Sessions = Number((ga4 as { sessions?: number } | null)?.sessions ?? 0);
  const businessEvents = Number((overview as { interactions?: number } | null)?.interactions ?? 0);
  const leads = Number((overview as { totalLeads?: number } | null)?.totalLeads ?? 0);

  if (!hasSignal(c, ga4Sessions, businessEvents, leads)) {
    return NOT_AVAILABLE('Not enough traffic yet to generate a reliable summary — this fills in as visitors arrive.');
  }

  const dataSources: string[] = [];
  if (c.configured) dataSources.push('Microsoft Clarity');
  if (isGa4Configured() && ga4Sessions > 0) dataSources.push('Google Analytics 4');
  if (businessEvents > 0 || leads > 0) dataSources.push('First-party website data');

  const metrics = {
    clarity: c.configured ? c.totals : null,
    clarityBreakdowns: c.configured ? { device: c.byDevice, country: c.byCountry, topPages: c.byUrl } : null,
    ga4: ga4 && (ga4 as { configured?: boolean }).configured ? ga4 : null,
    business: overview ?? null,
    funnel: funnel ?? null
  };

  try {
    const res = await createMessage({
      model: env.ANTHROPIC_REASONING_MODEL,
      system: SYSTEM,
      tools: [],
      maxTokens: 1400,
      temperature: 0.4,
      messages: [{ role: 'user', content: promptFor(metrics) }]
    });
    const parsed = extractJson<{ summary?: string; insights?: unknown[] }>(res.text);
    if (!parsed) return NOT_AVAILABLE('The analyst summary returned an unexpected response — try refreshing.');

    const insights = (parsed.insights ?? [])
      .map((x, i) => normInsight(x, i))
      .filter((x): x is UxInsight => Boolean(x))
      .sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])
      .slice(0, 6);

    const data: UxInsightsResult = {
      available: insights.length > 0 || Boolean(parsed.summary),
      reason: insights.length ? undefined : 'No additional AI recommendations beyond the deterministic actions.',
      generatedAt: new Date().toISOString(),
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 600) : null,
      insights,
      dataSources
    };
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'summary generation failed';
    return NOT_AVAILABLE(`Couldn't generate the AI summary right now (${msg}).`);
  }
};
