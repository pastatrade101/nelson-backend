import { Router } from 'express';
import {
  assignContactMessage,
  createContactMessage,
  deleteContactMessage,
  getContactMessage,
  listContactMessages,
  updateContactMessageNotes,
  updateContactMessageStatus
} from '../controllers/contact.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { publicFormLimiter } from '../middleware/rate-limit.middleware';
import { validate } from '../middleware/validate.middleware';
import { contactAssignSchema, contactCreateSchema, contactNotesSchema, contactStatusSchema } from '../schemas/contact.schema';

const router = Router();

router.post('/', publicFormLimiter, validate({ body: contactCreateSchema }), createContactMessage);
router.get('/messages', authenticate, requirePermission('messages.view'), listContactMessages);
router.get('/messages/:id', authenticate, requirePermission('messages.view'), getContactMessage);
router.put('/messages/:id/status', authenticate, requirePermission('messages.update'), validate({ body: contactStatusSchema }), updateContactMessageStatus);
router.put('/messages/:id/assign', authenticate, requirePermission('messages.update'), validate({ body: contactAssignSchema }), assignContactMessage);
router.put('/messages/:id/notes', authenticate, requirePermission('messages.update'), validate({ body: contactNotesSchema }), updateContactMessageNotes);
router.delete('/messages/:id', authenticate, requirePermission('messages.archive'), deleteContactMessage);

export default router;
