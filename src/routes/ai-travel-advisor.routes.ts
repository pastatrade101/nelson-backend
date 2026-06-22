import { Router } from 'express';
import {
  adminCreateBooking,
  chatWithAdvisor,
  createBookingRequest,
  getAiConversation,
  getAiEvals,
  getAiUsage,
  getTourMatches,
  handoffAiConversation,
  listAiConversations,
  refreshEmbeddings,
  updateAiConversationStatus
} from '../controllers/ai-travel-advisor.controller';
import { aiChatGuard, aiChatLimiter } from '../middleware/ai-guard.middleware';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { aiAdminBookingSchema, aiChatSchema, aiCreateBookingSchema, aiHandoffSchema, aiStatusSchema } from '../schemas/ai.schema';

const router = Router();

// Public chat (CGNAT-aware abuse protection: guard establishes the signed
// session token + Turnstile, limiter rate-limits per session, then validate).
router.post('/chat', aiChatGuard, aiChatLimiter, validate({ body: aiChatSchema }), chatWithAdvisor);
router.post(
  '/conversations/:id/create-booking-request',
  aiChatGuard,
  aiChatLimiter,
  validate({ body: aiCreateBookingSchema }),
  createBookingRequest
);

// Admin.
router.get('/conversations', authenticate, requirePermission('ai_conversations.view'), listAiConversations);
router.get('/conversations/:id', authenticate, requirePermission('ai_conversations.view'), getAiConversation);
router.post('/conversations/:id/handoff', authenticate, requirePermission('ai_conversations.handoff'), validate({ body: aiHandoffSchema }), handoffAiConversation);
router.put('/conversations/:id/status', authenticate, requirePermission('ai_conversations.handoff'), validate({ body: aiStatusSchema }), updateAiConversationStatus);
router.post('/conversations/:id/create-booking', authenticate, requirePermission('ai_conversations.handoff'), validate({ body: aiAdminBookingSchema }), adminCreateBooking);
router.get('/usage', authenticate, requirePermission('ai_conversations.view'), getAiUsage);
router.get('/evals', authenticate, requirePermission('ai_conversations.view'), getAiEvals);
router.get('/tour-matches/:conversationId', authenticate, requirePermission('tour_matches.view'), getTourMatches);
router.post('/embeddings/refresh', authenticate, requirePermission('ai_conversations.view'), refreshEmbeddings);

export default router;
