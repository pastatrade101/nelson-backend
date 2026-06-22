import type { Request, Response } from 'express';
import { supabase } from '../config/supabase';
import {
  createBookingRequestForConversation,
  handoffConversation,
  runAdvisorTurn,
  type AdvisorTurnInput,
  type AdvisorTurnResult
} from '../services/ai-travel-advisor.service';
import { embedCmsContent } from '../services/ai-retrieval.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getRecordById, listRecords } from '../utils/supabase-helpers';

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
  return getRecordById(res, 'ai_conversations', req.params.id);
});

export const handoffAiConversation = asyncHandler(async (req, res) => {
  const data = await handoffConversation(req.params.id, req, req.body.notes);
  return sendSuccess(res, 'AI conversation marked for advisor handoff.', data);
});

export const refreshEmbeddings = asyncHandler(async (_req, res) => {
  const data = await embedCmsContent();
  return sendSuccess(res, data.enabled ? 'CMS embeddings refreshed.' : 'Embedding provider is not configured.', data);
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
