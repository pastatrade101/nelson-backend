import { Router } from 'express';
import {
  chatWithAdvisor,
  getAiConversation,
  getTourMatches,
  handoffAiConversation,
  listAiConversations
} from '../controllers/ai-travel-advisor.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { publicFormLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { aiChatSchema, aiHandoffSchema } from '../schemas/ai.schema';

const router = Router();

router.post('/chat', publicFormLimiter, validate({ body: aiChatSchema }), chatWithAdvisor);
router.get('/conversations', authenticate, requirePermission('ai_conversations.view'), listAiConversations);
router.get('/conversations/:id', authenticate, requirePermission('ai_conversations.view'), getAiConversation);
router.post('/conversations/:id/handoff', authenticate, requirePermission('ai_conversations.handoff'), validate({ body: aiHandoffSchema }), handoffAiConversation);
router.get('/tour-matches/:conversationId', authenticate, requirePermission('tour_matches.view'), getTourMatches);

export default router;
