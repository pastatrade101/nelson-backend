import { Router } from 'express';
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
  updateUserPassword,
  updateUserStatus
} from '../controllers/users.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { userCreateSchema, userPasswordSchema, userStatusSchema, userUpdateSchema } from '../schemas/users.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('admin_users.view'), listUsers);
router.get('/:id', requirePermission('admin_users.view'), getUser);
router.post('/', requirePermission('admin_users.create'), validate({ body: userCreateSchema }), createUser);
router.put('/:id/status', requirePermission('admin_users.update'), validate({ body: userStatusSchema }), updateUserStatus);
router.put('/:id/password', requirePermission('admin_users.update'), validate({ body: userPasswordSchema }), updateUserPassword);
router.put('/:id', requirePermission('admin_users.update'), validate({ body: userUpdateSchema }), updateUser);
router.delete('/:id', requirePermission('admin_users.delete'), deleteUser);

export default router;
