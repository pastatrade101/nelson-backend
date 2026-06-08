import { supabase } from '../config/supabase';
import { handoffConversation, handleAdvisorChat } from '../services/ai-travel-advisor.service';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';
import { getRecordById, listRecords } from '../utils/supabase-helpers';

export const chatWithAdvisor = asyncHandler(async (req, res) => {
  const data = await handleAdvisorChat(req.body);
  return sendSuccess(res, 'Goldfinch AI Travel Advisor response generated.', data, 201);
});

export const listAiConversations = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'ai_conversations',
    searchColumns: ['status', 'channel'],
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
