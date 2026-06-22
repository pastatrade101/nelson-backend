import { env } from '../config/env';
import { supabase } from '../config/supabase';

// ----------------------------------------------------------------------------
// Token usage + cost estimation + usage logging (§5, §24).
// All Anthropic spend is estimated from token counts so the budget guard and
// the admin usage dashboard have a single source of truth.
// ----------------------------------------------------------------------------

export type AiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export type RequestStatus =
  | 'success'
  | 'failed'
  | 'blocked_rate_limit'
  | 'blocked_budget_limit'
  | 'skipped_no_ai_needed'
  | 'semantic_cache_hit'
  | 'degraded'
  | 'fallback';

export const emptyUsage = (): AiUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0
});

// USD per single token (Anthropic list prices, per-MTok / 1e6).
type Price = { input: number; output: number };
const PER_MTOK = (input: number, output: number): Price => ({ input: input / 1e6, output: output / 1e6 });

const PRICING: Record<string, Price> = {
  'claude-haiku-4-5-20251001': PER_MTOK(1, 5),
  'claude-sonnet-4-6': PER_MTOK(3, 15)
};

const priceFor = (model: string): Price => {
  if (PRICING[model]) return PRICING[model];
  // Fall back by family so a minor model-id bump never zeroes out cost tracking.
  if (model.includes('haiku')) return PER_MTOK(1, 5);
  if (model.includes('sonnet')) return PER_MTOK(3, 15);
  if (model.includes('opus')) return PER_MTOK(15, 75);
  return PER_MTOK(3, 15);
};

// Cache-write multiplier on the base input rate: 5-minute = 1.25x, 1-hour = 2x.
const cacheWriteMultiplier = () => (env.AI_PROMPT_CACHE_TTL === '1h' ? 2 : 1.25);
const CACHE_READ_MULTIPLIER = 0.1;

/** Estimated USD cost for a single Anthropic call from its token usage. */
export const estimateCostUsd = (model: string, usage: AiUsage): number => {
  const price = priceFor(model);
  const cost =
    usage.input_tokens * price.input +
    usage.output_tokens * price.output +
    usage.cache_creation_input_tokens * price.input * cacheWriteMultiplier() +
    usage.cache_read_input_tokens * price.input * CACHE_READ_MULTIPLIER;
  // Round to 6 dp to match the numeric(12,6) column.
  return Math.round(cost * 1e6) / 1e6;
};

/** Rough token estimate (~4 chars/token) for pre-call budget/size checks (§5.4). */
export const estimateTokens = (text: string): number => Math.ceil((text?.length ?? 0) / 4);

export type LogUsageInput = {
  conversationId?: string | null;
  sessionId?: string | null;
  ipHash?: string | null;
  model?: string | null;
  routeType: string;
  usage?: AiUsage;
  estimatedCostUsd?: number;
  requestStatus?: RequestStatus;
  errorMessage?: string | null;
};

/**
 * Best-effort usage log. Never throws — a logging failure must not break the
 * chat reply. Returns the estimated cost so callers can roll it up onto the
 * conversation total.
 */
export const logUsage = async (input: LogUsageInput): Promise<number> => {
  const usage = input.usage ?? emptyUsage();
  const model = input.model ?? null;
  const estimatedCost =
    input.estimatedCostUsd ?? (model ? estimateCostUsd(model, usage) : 0);

  try {
    await supabase.from('ai_usage_logs').insert({
      conversation_id: input.conversationId ?? null,
      session_id: input.sessionId ?? null,
      ip_hash: input.ipHash ?? null,
      model,
      route_type: input.routeType,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      estimated_cost_usd: estimatedCost,
      request_status: input.requestStatus ?? 'success',
      error_message: input.errorMessage ?? null
    });
  } catch {
    // Swallow — usage logging is observability, not a hard dependency.
  }

  return estimatedCost;
};
