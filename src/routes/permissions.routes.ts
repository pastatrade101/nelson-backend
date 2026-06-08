import { Router } from 'express';
import { listPermissions } from '../controllers/permissions.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.get('/', authenticate, requirePermission('roles.view'), listPermissions);

export default router;
