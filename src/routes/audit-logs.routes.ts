import { Router } from 'express';
import { getAuditLog, listAuditLogs } from '../controllers/audit-logs.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('audit_logs.view'), listAuditLogs);
router.get('/:id', requirePermission('audit_logs.view'), getAuditLog);

export default router;
