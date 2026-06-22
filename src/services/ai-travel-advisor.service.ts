import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { env } from '../config/env';
import { supabase } from '../config/supabase';
import { GOLDFINCH_ADVISOR_TOOLS } from '../prompts/goldfinch-advisor.prompt';
import { createMessage, type AnthropicMessage, type AnthropicRole } from './anthropic.service';
import { budgetFallbackMessage, getBudgetStatus } from './ai-cost-control.service';
import { classifyMessage } from './ai-router.service';
import { executeTool, getSettings, searchTours, type AdvisorContext, type PageContext, type Recommendation } from './ai-tools.service';
import { lookupAnswerCache, searchFaqSemantic, storeAnswerCache } from './ai-retrieval.service';
import { logUsage, type AiUsage, type RequestStatus } from './ai-usage.service';
import { syncToHubSpot } from './hubspot.service';

// ----------------------------------------------------------------------------
// Orchestration + native tool loop (§1, §3, §5, §7). Runs the router first,
// applies the degradation ladder, and only calls Anthropic when a route truly
// needs it. The model can only use CMS data returned by tools.
// ----------------------------------------------------------------------------

const MAX_TOOL_ROUNDS = 4;
const norm = (v?: unknown) => String(v ?? '').trim().toLowerCase();

export type SuggestedAction = {
  type: 'plan_my_trip' | 'whatsapp' | 'booking_request' | 'talk_to_human';
  label: string;
  url?: string;
};

export type AdvisorTurnInput = {
  conversationId?: string;
  message: string;
  lead?: Record<string, unknown>;
  pageContext?: PageContext;
  sessionId?: string;
  ipHash?: string;
  turnstileVerified?: boolean;
  idempotencyKey?: string;
};

export type AdvisorTurnResult = {
  conversationId: string;
  reply: string;
  language: string;
  recommendations: Recommendation[];
  tourMatches: Recommendation[]; // back-compat alias for the existing widget
  suggestedActions: SuggestedAction[];
  leadContext: Record<string, unknown>;
  handoffRequired: boolean;
  route: string;
  degraded: boolean;
  usage: { route_type: string; ai_called: boolean; model?: string; degraded?: boolean };
};

// ── language detection (EN/SW minimum, §1.2) ─────────────────────────────────
const SWAHILI_HINTS = ['habari', 'asante', 'tafadhali', 'ningependa', 'nataka', 'gani', 'lini', 'bei', 'siku', 'watu', 'familia', 'safari ya', 'naomba', 'karibu', 'jambo'];
const detectLanguage = (message: string): string => {
  const m = norm(message);
  return SWAHILI_HINTS.some((w) => m.includes(w)) ? 'sw' : 'en';
};

const HUMAN_REQUEST = ['human', 'agent', 'real person', 'speak to someone', 'talk to a person', 'talk to someone', 'call me', 'representative'];
const wantsHuman = (message: string) => HUMAN_REQUEST.some((w) => norm(message).includes(w));

// ── conversation persistence ─────────────────────────────────────────────────
const ensureConversation = async (input: AdvisorTurnInput, language: string): Promise<string> => {
  if (input.conversationId) return input.conversationId;
  const fallbackId = randomUUID();
  try {
    const { data } = await supabase
      .from('ai_conversations')
      .insert({
        channel: 'website',
        status: 'in_progress',
        lead_context: input.lead ?? {},
        session_id: input.sessionId ?? null,
        source_page: input.pageContext?.path ?? null,
        language,
        turnstile_verified: Boolean(input.turnstileVerified)
      })
      .select('id')
      .single();
    return (data as { id?: string } | null)?.id ?? fallbackId;
  } catch {
    return fallbackId;
  }
};

const saveMessage = async (conversationId: string, role: 'assistant' | 'user', content: string) => {
  try {
    await supabase.from('ai_messages').insert({ conversation_id: conversationId, role, content });
  } catch {
    // best effort
  }
};

const loadHistory = async (conversationId: string, currentMessage: string): Promise<AnthropicMessage[]> => {
  let ordered: Array<{ role: string; content: string }> = [];
  try {
    const { data } = await supabase
      .from('ai_messages')
      .select('role,content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(8);
    ordered = ((data ?? []) as Array<{ role: string; content: string }>).reverse();
  } catch {
    ordered = [];
  }
  const messages: AnthropicMessage[] = ordered
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as AnthropicRole, content: String(m.content) }));
  if (!messages.length || messages[messages.length - 1].content !== currentMessage) {
    messages.push({ role: 'user', content: currentMessage });
  }
  return messages;
};

const persistMatches = async (conversationId: string, recs: Recommendation[]) => {
  if (!recs.length) return;
  try {
    await supabase.from('tour_match_results').insert(
      recs.map((r) => ({
        conversation_id: conversationId,
        tour_id: r.tour_id,
        match_score: r.score,
        score: r.score,
        confidence_label: r.confidence_label,
        reasons: r.reasons,
        limitations: r.limitations,
        availability_status: r.availability_note,
        price_note: r.price_from != null ? `${r.currency} ${r.price_from}` : null
      }))
    );
  } catch {
    // best effort
  }
};

// ── lead scoring (§19) ───────────────────────────────────────────────────────
const scoreLead = (lc: Record<string, unknown>): number => {
  let s = 0;
  if (lc.phone) s += 20;
  if (lc.email) s += 20;
  if (lc.preferred_month || lc.start_date || lc.travel_timing) s += 15;
  if (lc.total_travelers || lc.adults) s += 15;
  if (lc.budget_tier || lc.comfort_level) s += 15;
  if (lc.preferred_tour_id || lc.preferred_departure_id) s += 20;
  if (norm(lc.urgency).includes('high')) s += 10;
  const destInterest = Array.isArray(lc.destination_interest) ? lc.destination_interest.length : 0;
  const expInterest = Array.isArray(lc.experience_interest) ? lc.experience_interest.length : 0;
  if (destInterest || expInterest || lc.destination) s += 10;
  return Math.min(s, 100);
};
const leadLabel = (s: number): string => (s >= 81 ? 'qualified' : s >= 61 ? 'hot' : s >= 31 ? 'warm' : 'cold');

// ── suggested actions ────────────────────────────────────────────────────────
const buildActions = async (recommendations: Recommendation[], handoff: boolean): Promise<SuggestedAction[]> => {
  const actions: SuggestedAction[] = [{ type: 'plan_my_trip', label: 'Plan My Trip', url: '/plan-my-trip' }];
  const settings = (await getSettings()).output as { whatsapp_number?: string; whatsapp_default_message?: string };
  const digits = String(settings.whatsapp_number ?? '').replace(/\D/g, '');
  if (digits) {
    const text = String(settings.whatsapp_default_message ?? 'Hi Goldfinch, I would like help planning a trip.');
    actions.push({ type: 'whatsapp', label: 'Continue on WhatsApp', url: `https://wa.me/${digits}?text=${encodeURIComponent(text)}` });
  }
  if (recommendations.length) actions.push({ type: 'booking_request', label: 'Create a booking request' });
  if (handoff) actions.push({ type: 'talk_to_human', label: 'Talk to a specialist' });
  return actions;
};

const buildDynamicContext = (input: AdvisorTurnInput, language: string, degraded: boolean): string => {
  const parts: string[] = [];
  parts.push(`Visitor language: ${language}. Reply in ${language === 'sw' ? 'Swahili' : 'English'}.`);
  if (input.pageContext?.path) parts.push(`Current page: ${input.pageContext.path}.`);
  if (input.pageContext?.tour_id || input.pageContext?.tour_slug) {
    parts.push(`Visitor is viewing tour ${input.pageContext.tour_slug ?? input.pageContext.tour_id}.`);
  }
  if (input.lead && Object.keys(input.lead).length) parts.push(`Known lead context: ${JSON.stringify(input.lead).slice(0, 600)}.`);
  if (degraded) parts.push('Cost-saver mode: keep the reply short and skip long itineraries.');
  return parts.join(' ');
};

// ── main entry: run one advisor turn ─────────────────────────────────────────
export const runAdvisorTurn = async (input: AdvisorTurnInput): Promise<AdvisorTurnResult> => {
  const language = detectLanguage(input.message);
  const conversationId = await ensureConversation(input, language);
  const ctx: AdvisorContext = {
    conversationId,
    sessionId: input.sessionId,
    ipHash: input.ipHash,
    pageContext: input.pageContext,
    queryText: input.message
  };

  await saveMessage(conversationId, 'user', input.message);

  const decision = classifyMessage(input.message);
  const budget = await getBudgetStatus();
  const degraded = budget.tier !== 'normal';
  const handoffRequired = wantsHuman(input.message);

  const finalize = async (
    reply: string,
    opts: { recommendations?: Recommendation[]; routeType: string; aiCalled: boolean; model?: string; status: RequestStatus; usage?: AiUsage; cost?: number }
  ): Promise<AdvisorTurnResult> => {
    await saveMessage(conversationId, 'assistant', reply);
    const recommendations = opts.recommendations ?? [];
    await persistMatches(conversationId, recommendations);

    const cost = await logUsage({
      conversationId,
      sessionId: input.sessionId,
      ipHash: input.ipHash,
      model: opts.model ?? null,
      routeType: opts.routeType,
      usage: opts.usage,
      estimatedCostUsd: opts.usage ? undefined : opts.cost ?? 0,
      requestStatus: opts.status
    });

    let leadContextRow: Record<string, unknown> = {};
    try {
      const [leadRes, convRes] = await Promise.all([
        supabase.from('ai_lead_context').select('*').eq('conversation_id', conversationId).maybeSingle(),
        supabase.from('ai_conversations').select('total_estimated_cost_usd,ai_message_count').eq('id', conversationId).maybeSingle()
      ]);
      leadContextRow = (leadRes.data ?? {}) as Record<string, unknown>;
      const leadScore = scoreLead(leadContextRow);
      const conv = (convRes.data ?? {}) as { total_estimated_cost_usd?: number; ai_message_count?: number };
      const update: Record<string, unknown> = {
        language,
        degraded,
        handoff_required: handoffRequired,
        lead_score: leadScore,
        lead_status: leadLabel(leadScore),
        total_estimated_cost_usd: Number(conv.total_estimated_cost_usd ?? 0) + cost,
        ai_message_count: Number(conv.ai_message_count ?? 0) + 1
      };
      if (opts.aiCalled) update.last_ai_call_at = new Date().toISOString();
      await supabase.from('ai_conversations').update(update).eq('id', conversationId);
    } catch {
      // best effort
    }

    const actions = await buildActions(recommendations, handoffRequired);
    return {
      conversationId,
      reply,
      language,
      recommendations,
      tourMatches: recommendations,
      suggestedActions: actions,
      leadContext: leadContextRow,
      handoffRequired,
      route: opts.routeType,
      degraded,
      usage: { route_type: opts.routeType, ai_called: opts.aiCalled, model: opts.model, degraded }
    };
  };

  // 1) AI disabled or full budget cliff → WhatsApp fallback.
  if (!budget.aiEnabled || budget.tier === 'fallback_whatsapp') {
    return finalize(budgetFallbackMessage, { routeType: 'fallback', aiCalled: false, status: 'fallback' });
  }

  // 2) No-AI deterministic routes (answered from CMS/settings).
  if (!decision.needsAi) {
    if (decision.route === 'cms_contact_no_ai') {
      const s = (await getSettings()).output as Record<string, unknown>;
      const reply = `You can reach Goldfinch at ${s.contact_email || 'our contact page'}${s.contact_phone ? ` or ${s.contact_phone}` : ''}.${s.business_hours ? ` Hours: ${s.business_hours}.` : ''} ${s.response_time ?? ''}`.trim();
      return finalize(reply, { routeType: decision.route, aiCalled: false, status: 'skipped_no_ai_needed' });
    }
    if (decision.route === 'cms_search_no_ai') {
      const recs = await searchTours({}, ctx);
      const reply = recs.length
        ? 'Here are a few popular Goldfinch trips to start with — tell me your dates, group and budget and I can narrow them down.'
        : 'I can help you find the right trip. Tell me your destination, dates, group size and budget.';
      return finalize(reply, { recommendations: recs, routeType: decision.route, aiCalled: false, status: 'skipped_no_ai_needed' });
    }
    // cms_faq_no_ai — try a semantic FAQ match first (§10), else generic.
    const faqMatch = await searchFaqSemantic(input.message);
    if (faqMatch) {
      let answer = faqMatch.content;
      try {
        const { data: faqRow } = await supabase.from('faqs').select('answer').eq('id', faqMatch.sourceId).maybeSingle();
        const a = (faqRow as { answer?: string } | null)?.answer;
        if (a) answer = a;
      } catch {
        // fall back to the embedded content
      }
      return finalize(answer, { routeType: decision.route, aiCalled: false, status: 'skipped_no_ai_needed' });
    }
    const s = (await getSettings()).output as Record<string, unknown>;
    const reply = `Booking with Goldfinch is simple: tell us what you want, we tailor a plan and send a booking request for review — no payment to start. ${s.response_time ?? 'A specialist will follow up shortly.'}`;
    return finalize(reply, { routeType: decision.route, aiCalled: false, status: 'skipped_no_ai_needed' });
  }

  // 2b) Semantic answer cache (§10): for general questions, a close enough
  // cached answer skips Anthropic entirely. Skipped for trip-match / booking
  // routes, which need live data.
  if (decision.route === 'ai_simple') {
    const cached = await lookupAnswerCache(input.message);
    if (cached) {
      return finalize(cached.answer, { routeType: 'semantic_cache_hit_no_ai', aiCalled: false, status: 'semantic_cache_hit' });
    }
  }

  // 3) Budget exhausted but AI requested → template/fallback (semantic cache already tried above).
  if (budget.tier === 'cache_template_only') {
    return finalize(budgetFallbackMessage, { routeType: 'degraded', aiCalled: false, status: 'degraded' });
  }

  // 4) AI route: native tool loop with Anthropic.
  const model =
    budget.tier === 'degraded_haiku_only'
      ? env.ANTHROPIC_SIMPLE_MODEL
      : decision.model === 'reasoning'
        ? env.ANTHROPIC_REASONING_MODEL
        : env.ANTHROPIC_SIMPLE_MODEL;

  const messages = await loadHistory(conversationId, input.message);
  const dynamicContext = buildDynamicContext(input, language, degraded);

  const totalUsage: AiUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let recommendations: Recommendation[] = [];
  let finalText = '';

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const res = await createMessage({
        model,
        messages,
        tools: GOLDFINCH_ADVISOR_TOOLS as unknown as ReadonlyArray<Record<string, unknown>>,
        dynamicContext,
        maxTokens: env.AI_MAX_OUTPUT_TOKENS
      });

      totalUsage.input_tokens += res.usage.input_tokens;
      totalUsage.output_tokens += res.usage.output_tokens;
      totalUsage.cache_creation_input_tokens += res.usage.cache_creation_input_tokens;
      totalUsage.cache_read_input_tokens += res.usage.cache_read_input_tokens;

      if (res.toolUses.length) {
        messages.push({ role: 'assistant', content: res.content });
        const toolResults: Array<Record<string, unknown>> = [];
        for (const tu of res.toolUses) {
          if (tu.name === 'create_booking_request' && input.idempotencyKey && !tu.input.idempotency_key) {
            tu.input.idempotency_key = input.idempotencyKey;
          }
          const r = await executeTool(tu.name, tu.input, ctx);
          if (tu.name === 'search_tours' && Array.isArray((r.output as { recommendations?: unknown }).recommendations)) {
            recommendations = (r.output as { recommendations: Recommendation[] }).recommendations;
          }
          toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(r.output) });
        }
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      finalText = res.text;
      break;
    }
  } catch {
    return finalize(
      "I'm having trouble reaching our planning engine right now. A Goldfinch specialist can help you directly — would you like to continue on WhatsApp?",
      { routeType: decision.route, aiCalled: true, model, status: 'failed', usage: totalUsage }
    );
  }

  const reply = finalText.trim() || 'Let me connect you with a Goldfinch specialist who can help further.';

  // Cache general, reusable answers (never trip/price/availability content) so
  // the next similar question skips Anthropic (§10). storeAnswerCache itself
  // filters volatile content and is a no-op when embeddings are disabled.
  if (decision.route === 'ai_simple' && !recommendations.length && !degraded && finalText.trim()) {
    await storeAnswerCache(input.message, reply, 'ai_simple');
  }

  return finalize(reply, {
    recommendations,
    routeType: degraded ? 'degraded' : decision.route,
    aiCalled: true,
    model,
    status: degraded ? 'degraded' : 'success',
    usage: totalUsage
  });
};

// ── admin: mark a conversation for human handoff (existing behaviour) ─────────
export const handoffConversation = async (conversationId: string, req: Request, notes?: string) => {
  const { data: context } = await supabase.from('ai_lead_context').select('*').eq('conversation_id', conversationId).maybeSingle();
  const hubspot = context?.email
    ? await syncToHubSpot('lead', { ...context, message: notes, source: 'Goldfinch AI Travel Advisor' })
    : { configured: false, skipped: true };

  await supabase
    .from('ai_conversations')
    .update({ handoff_at: new Date().toISOString(), handoff_by: req.user?.sub, handoff_required: true, handoff_reason: notes ?? 'Manual handoff', status: 'handoff_ready' })
    .eq('id', conversationId);

  return { conversationId, hubspot };
};

/** Idempotent booking-request creation outside the model loop (§13 / §22 endpoint). */
export const createBookingRequestForConversation = async (conversationId: string, idempotencyKey: string) => {
  const { createBookingRequest } = await import('./ai-tools.service');
  const result = await createBookingRequest({ idempotency_key: idempotencyKey }, { conversationId });
  return result.output;
};
