import { Router } from 'express';
import {
  createSafetyTopic,
  deleteSafetyTopic,
  getSafetyTopic,
  listSafetyTopics,
  updateSafetyTopic
} from '../controllers/safety-topics.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { safetyTopicCreateSchema, safetyTopicUpdateSchema } from '../schemas/safety-topics.schema';

const router = Router();

router.get('/', listSafetyTopics);
router.get('/:slug', getSafetyTopic);
router.post('/', authenticate, requirePermission('safety_topics.create'), validate({ body: safetyTopicCreateSchema }), createSafetyTopic);
router.put('/:id', authenticate, requirePermission('safety_topics.update'), validate({ body: safetyTopicUpdateSchema }), updateSafetyTopic);
router.delete('/:id', authenticate, requirePermission('safety_topics.delete'), deleteSafetyTopic);

export default router;
