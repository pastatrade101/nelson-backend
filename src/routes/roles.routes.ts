import { Router } from 'express';
import { listPermissions, listRoles, updateRolePermissions } from '../controllers/roles.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('roles.view'), listRoles);
router.get('/permissions', requirePermission('roles.view'), listPermissions);
router.put('/:role/permissions', requirePermission('roles.update'), updateRolePermissions);

export default router;
