import { env } from '../config/env';
import { supabase } from '../config/supabase';

// ----------------------------------------------------------------------------
// AI economy + graceful degradation ladder (§4, §5.2, §5.3).
// Instead of a hard budget cliff we step down: normal -> haiku-only ->
// cache/template -> WhatsApp fallback.
// ----------------------------------------------------------------------------

export type DegradationTier =
  | 'normal'
  | 'degraded_haiku_only'
  | 'cache_template_only'
  | 'fallback_whatsapp';

export type BudgetStatus = {
  tier: DegradationTier;
  reason: string;
  aiEnabled: boolean;
  spendTodayUsd: number;
  spendMonthUsd: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  dailyRemainingUsd: number;
  monthlyRemainingUsd: number;
};

const startOfTodayIso = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
};

const startOfMonthIso = (): string => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
};

const sumCostSince = async (sinceIso: string): Promise<number> => {
  try {
    const { data, error } = await supabase
      .from('ai_usage_logs')
      .select('estimated_cost_usd')
      .gte('created_at', sinceIso);
    if (error || !data) return 0;
    return data.reduce((total, row) => total + Number((row as { estimated_cost_usd?: number }).estimated_cost_usd ?? 0), 0);
  } catch {
    return 0;
  }
};

export const getSpend = async (): Promise<{ today: number; month: number }> => {
  const [today, month] = await Promise.all([sumCostSince(startOfTodayIso()), sumCostSince(startOfMonthIso())]);
  return { today, month };
};

/**
 * Current degradation tier based on AI_ENABLED + daily/monthly spend. Read-only;
 * the orchestrator decides what to do with the tier (force Haiku, serve cache,
 * or offer WhatsApp).
 */
export const getBudgetStatus = async (): Promise<BudgetStatus> => {
  const dailyBudgetUsd = env.AI_DAILY_BUDGET_USD;
  const monthlyBudgetUsd = env.AI_MONTHLY_BUDGET_USD;
  const { today, month } = await getSpend();

  const base: Omit<BudgetStatus, 'tier' | 'reason'> = {
    aiEnabled: env.AI_ENABLED,
    spendTodayUsd: today,
    spendMonthUsd: month,
    dailyBudgetUsd,
    monthlyBudgetUsd,
    dailyRemainingUsd: Math.max(dailyBudgetUsd - today, 0),
    monthlyRemainingUsd: Math.max(monthlyBudgetUsd - month, 0)
  };

  if (!env.AI_ENABLED) {
    return { ...base, tier: 'fallback_whatsapp', reason: 'AI disabled by configuration.' };
  }
  if (today >= dailyBudgetUsd || month >= monthlyBudgetUsd) {
    return { ...base, tier: 'cache_template_only', reason: 'Budget exhausted — serving cache/CMS only.' };
  }
  if (today >= dailyBudgetUsd * env.AI_DEGRADE_AT_BUDGET_FRACTION) {
    return { ...base, tier: 'degraded_haiku_only', reason: 'Approaching daily budget — Haiku-only mode.' };
  }
  return { ...base, tier: 'normal', reason: 'Within budget.' };
};

/** Friendly, brand-safe message shown when the assistant is degraded/limited. */
export const budgetFallbackMessage =
  "I've reached today's automated assistant limit, but you can continue with a Goldfinch specialist on WhatsApp.";

// ── Per-session / per-IP message counters (weak IP signal per §6) ────────────

export const countSessionMessagesToday = async (sessionId: string): Promise<number> => {
  if (!sessionId) return 0;
  try {
    const { count } = await supabase
      .from('ai_usage_logs')
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
      .gte('created_at', startOfTodayIso());
    return count ?? 0;
  } catch {
    return 0;
  }
};

// ── usage dashboard aggregation (§24) ────────────────────────────────────────
export type UsageStats = {
  aiEnabled: boolean;
  tier: DegradationTier;
  spendTodayUsd: number;
  spendMonthUsd: number;
  dailyBudgetUsd: number;
  monthlyBudgetUsd: number;
  dailyRemainingUsd: number;
  monthlyRemainingUsd: number;
  messagesToday: number;
  anthropicCallsToday: number;
  skippedNoAiToday: number;
  semanticCacheHitsToday: number;
  blockedRateLimitToday: number;
  blockedBudgetToday: number;
  degradedToday: number;
  costByModel: Array<{ model: string; cost: number; calls: number }>;
  costByRoute: Array<{ route: string; count: number; cost: number }>;
  topConversations: Array<{ conversation_id: string; cost: number; messages: number }>;
};

type UsageRow = {
  model: string | null;
  route_type: string;
  request_status: string;
  estimated_cost_usd: number | null;
  conversation_id: string | null;
  created_at: string;
};

export const getUsageStats = async (): Promise<UsageStats> => {
  const status = await getBudgetStatus();
  const monthStart = startOfMonthIso();
  const todayStart = startOfTodayIso();

  let rows: UsageRow[] = [];
  try {
    const { data } = await supabase
      .from('ai_usage_logs')
      .select('model,route_type,request_status,estimated_cost_usd,conversation_id,created_at')
      .gte('created_at', monthStart)
      .order('created_at', { ascending: false })
      .limit(5000);
    rows = (data ?? []) as UsageRow[];
  } catch {
    rows = [];
  }

  const today = rows.filter((r) => r.created_at >= todayStart);
  const countWhere = (list: UsageRow[], pred: (r: UsageRow) => boolean) => list.filter(pred).length;

  const byModel = new Map<string, { cost: number; calls: number }>();
  const byRoute = new Map<string, { count: number; cost: number }>();
  const byConv = new Map<string, { cost: number; messages: number }>();
  for (const r of rows) {
    const cost = Number(r.estimated_cost_usd ?? 0);
    if (r.model) {
      const m = byModel.get(r.model) ?? { cost: 0, calls: 0 };
      byModel.set(r.model, { cost: m.cost + cost, calls: m.calls + 1 });
    }
    const rt = byRoute.get(r.route_type) ?? { count: 0, cost: 0 };
    byRoute.set(r.route_type, { count: rt.count + 1, cost: rt.cost + cost });
    if (r.conversation_id) {
      const c = byConv.get(r.conversation_id) ?? { cost: 0, messages: 0 };
      byConv.set(r.conversation_id, { cost: c.cost + cost, messages: c.messages + 1 });
    }
  }

  const round = (n: number) => Math.round(n * 1e6) / 1e6;

  return {
    aiEnabled: status.aiEnabled,
    tier: status.tier,
    spendTodayUsd: round(status.spendTodayUsd),
    spendMonthUsd: round(status.spendMonthUsd),
    dailyBudgetUsd: status.dailyBudgetUsd,
    monthlyBudgetUsd: status.monthlyBudgetUsd,
    dailyRemainingUsd: round(status.dailyRemainingUsd),
    monthlyRemainingUsd: round(status.monthlyRemainingUsd),
    messagesToday: today.length,
    anthropicCallsToday: countWhere(today, (r) => r.request_status === 'success' || r.request_status === 'degraded'),
    skippedNoAiToday: countWhere(today, (r) => r.request_status === 'skipped_no_ai_needed'),
    semanticCacheHitsToday: countWhere(today, (r) => r.request_status === 'semantic_cache_hit'),
    blockedRateLimitToday: countWhere(today, (r) => r.request_status === 'blocked_rate_limit'),
    blockedBudgetToday: countWhere(today, (r) => r.request_status === 'blocked_budget_limit'),
    degradedToday: countWhere(today, (r) => r.request_status === 'degraded' || r.request_status === 'fallback'),
    costByModel: [...byModel.entries()].map(([model, v]) => ({ model, cost: round(v.cost), calls: v.calls })).sort((a, b) => b.cost - a.cost),
    costByRoute: [...byRoute.entries()].map(([route, v]) => ({ route, count: v.count, cost: round(v.cost) })).sort((a, b) => b.count - a.count),
    topConversations: [...byConv.entries()].map(([conversation_id, v]) => ({ conversation_id, cost: round(v.cost), messages: v.messages })).sort((a, b) => b.cost - a.cost).slice(0, 8)
  };
};

export const countIpMessagesToday = async (ipHash: string): Promise<number> => {
  if (!ipHash) return 0;
  try {
    const { count } = await supabase
      .from('ai_usage_logs')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('created_at', startOfTodayIso());
    return count ?? 0;
  } catch {
    return 0;
  }
};
