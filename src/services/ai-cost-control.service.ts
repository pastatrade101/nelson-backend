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
