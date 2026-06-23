import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import {
  createBookingRequestForConversation,
  handoffConversation,
  runAdvisorTurn,
  type AdvisorTurnInput,
  type AdvisorTurnResult
} from '../services/ai-travel-advisor.service';
import { getUsageStats } from '../services/ai-cost-control.service';
import { embedCmsContent } from '../services/ai-retrieval.service';
import { runAssist, type AssistContext, type AssistTask } from '../services/ai-admin-assist.service';
import { runEvals } from '../services/ai-eval.service';
import { purgeAnonymousConversations } from '../services/ai-retention.service';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { listRecords } from '../utils/supabase-helpers';

const buildTurnInput = (req: Request): AdvisorTurnInput => {
  const body = req.body as {
    conversationId?: string;
    message: string;
    lead?: Record<string, unknown>;
    page_context?: AdvisorTurnInput['pageContext'];
    idempotency_key?: string;
  };
  return {
    conversationId: body.conversationId,
    message: body.message,
    lead: body.lead,
    pageContext: body.page_context,
    idempotencyKey: body.idempotency_key,
    sessionId: req.aiSessionId,
    ipHash: req.aiIpHash,
    turnstileVerified: req.aiTurnstileVerified
  };
};

// Split a finished reply into sentence-ish chunks so the SSE client can render
// progressively. (True token streaming is available via streamMessage as a
// drop-in upgrade; tools must resolve before the final narration regardless.)
const chunkReply = (reply: string): string[] => {
  const parts = reply.match(/[^.!?\n]+[.!?\n]*\s*/g);
  return parts && parts.length ? parts : [reply];
};

const streamResult = (res: Response, result: AdvisorTurnResult) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  send('meta', { conversation_id: result.conversationId, language: result.language, route: result.route, degraded: result.degraded });
  if (result.recommendations.length) send('recommendations', result.recommendations);
  for (const chunk of chunkReply(result.reply)) send('delta', { text: chunk });
  send('done', {
    conversation_id: result.conversationId,
    reply: result.reply,
    language: result.language,
    lead_context: result.leadContext,
    recommendations: result.recommendations,
    suggested_actions: result.suggestedActions,
    handoff_required: result.handoffRequired,
    usage: result.usage
  });
  res.end();
};

export const chatWithAdvisor = asyncHandler(async (req, res) => {
  const result = await runAdvisorTurn(buildTurnInput(req));

  const wantsSse = String(req.headers.accept ?? '').includes('text/event-stream') || req.query.stream === '1';
  if (wantsSse) {
    streamResult(res, result);
    return;
  }

  // JSON (back-compat): keep conversationId + reply + tourMatches for the
  // existing widget, plus the full structured payload for the new one.
  return sendSuccess(res, 'Goldfinch AI Travel Advisor response generated.', {
    conversationId: result.conversationId,
    reply: result.reply,
    tourMatches: result.tourMatches,
    language: result.language,
    recommendations: result.recommendations,
    suggested_actions: result.suggestedActions,
    lead_context: result.leadContext,
    handoff_required: result.handoffRequired,
    usage: result.usage
  });
});

export const createBookingRequest = asyncHandler(async (req, res) => {
  const body = req.body as { idempotency_key: string };
  const data = await createBookingRequestForConversation(req.params.id, body.idempotency_key);
  return sendSuccess(res, 'Booking request received for review.', data, 201);
});

export const listAiConversations = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'ai_conversations',
    searchColumns: ['status', 'channel', 'visitor_name', 'visitor_email', 'lead_status'],
    statusColumn: 'status'
  });
});

export const getAiConversation = asyncHandler(async (req, res) => {
  const id = req.params.id;
  const [conv, messages, lead, matches] = await Promise.all([
    supabase.from('ai_conversations').select('*').eq('id', id).maybeSingle(),
    supabase.from('ai_messages').select('id,role,content,created_at').eq('conversation_id', id).order('created_at', { ascending: true }),
    supabase.from('ai_lead_context').select('*').eq('conversation_id', id).maybeSingle(),
    supabase.from('tour_match_results').select('*, tours(title,slug,price_from,currency)').eq('conversation_id', id).order('match_score', { ascending: false })
  ]);
  if (!conv.data) throw new AppError('Conversation not found.', 404);

  let usage = { calls: 0, cost: 0 };
  try {
    const { data } = await supabase.from('ai_usage_logs').select('estimated_cost_usd').eq('conversation_id', id);
    const list = (data ?? []) as Array<{ estimated_cost_usd?: number }>;
    usage = { calls: list.length, cost: Math.round(list.reduce((t, r) => t + Number(r.estimated_cost_usd ?? 0), 0) * 1e6) / 1e6 };
  } catch {
    // best effort
  }

  return sendSuccess(res, 'Conversation fetched.', {
    conversation: conv.data,
    messages: messages.data ?? [],
    lead_context: lead.data ?? null,
    tour_matches: matches.data ?? [],
    usage
  });
});

export const updateAiConversationStatus = asyncHandler(async (req, res) => {
  const { status, lead_status } = req.body as { status?: string; lead_status?: string };
  const update: Record<string, unknown> = {};
  if (status) update.status = status;
  if (lead_status) update.lead_status = lead_status;
  if (!Object.keys(update).length) throw new AppError('No status fields provided.', 400);

  const { data, error } = await supabase.from('ai_conversations').update(update).eq('id', req.params.id).select('id,status,lead_status').single();
  if (error) throw new AppError('Unable to update conversation.', 500, [error]);
  return sendSuccess(res, 'Conversation updated.', data);
});

export const adminCreateBooking = asyncHandler(async (req, res) => {
  const idempotencyKey = (req.body?.idempotency_key as string) || randomUUID();
  const data = await createBookingRequestForConversation(req.params.id, idempotencyKey);
  return sendSuccess(res, 'Booking request created.', data, 201);
});

export const getAiUsage = asyncHandler(async (_req, res) => {
  const data = await getUsageStats();
  return sendSuccess(res, 'AI usage stats fetched.', data);
});

export const getAiEvals = asyncHandler(async (_req, res) => {
  const { data } = await supabase.from('ai_eval_runs').select('*').order('run_at', { ascending: false }).limit(50);
  return sendSuccess(res, 'AI eval runs fetched.', data ?? []);
});

export const runAiEvals = asyncHandler(async (_req, res) => {
  const data = await runEvals();
  return sendSuccess(res, 'AI eval sweep complete.', data);
});

export const purgeAiRetention = asyncHandler(async (_req, res) => {
  const data = await purgeAnonymousConversations();
  return sendSuccess(res, 'Anonymous conversation purge complete.', data);
});

export const adminAssist = asyncHandler(async (req, res) => {
  const body = req.body as { task: AssistTask; text?: string; language?: 'en' | 'sw'; context?: AssistContext };
  const data = await runAssist(body.task, body.text ?? '', body.context ?? {}, body.language ?? 'en', req.user?.sub);
  return sendSuccess(res, 'AI draft generated.', data);
});

export const handoffAiConversation = asyncHandler(async (req, res) => {
  const data = await handoffConversation(req.params.id, req, req.body.notes);
  return sendSuccess(res, 'AI conversation marked for advisor handoff.', data);
});

// Backfilling embeds every published tour/destination/FAQ via the embedding
// provider — too slow for a single HTTP request (reverse proxies time out → 502).
// So we kick it off in the background and return immediately. The long-running
// Express process keeps working after the response is sent.
let embeddingsRunning = false;
export const refreshEmbeddings = asyncHandler(async (_req, res) => {
  if (embeddingsRunning) {
    return sendSuccess(res, 'Embeddings refresh is already running.', { started: false, alreadyRunning: true }, 202);
  }
  embeddingsRunning = true;
  void embedCmsContent()
    .then((result) => console.log('[embeddings] refresh complete:', result))
    .catch((err) => console.error('[embeddings] refresh failed:', (err as Error).message))
    .finally(() => {
      embeddingsRunning = false;
    });
  return sendSuccess(res, 'Embeddings refresh started — running in the background.', { started: true, alreadyRunning: false }, 202);
});

export const getTourMatches = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('tour_match_results')
    .select('*, tours(title,slug,price_from,currency)')
    .eq('conversation_id', req.params.conversationId)
    .order('match_score', { ascending: false });

  if (error) {
    return sendSuccess(res, 'Tour matches fetched successfully.', []);
  }

  return sendSuccess(res, 'Tour matches fetched successfully.', data ?? []);
});
