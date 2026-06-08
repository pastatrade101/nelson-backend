import { Router } from 'express';
import {
  createSetting,
  deleteSetting,
  getSetting,
  getSettingsByGroup,
  listSettings,
  updateSetting
} from '../controllers/settings.controller';
import { authenticate } from '../middleware/auth.middleware';
import { requirePermission } from '../middleware/permission.middleware';
import { validate } from '../middleware/validate.middleware';
import { settingCreateSchema, settingUpdateSchema } from '../schemas/settings.schema';

const router = Router();

router.use(authenticate);
router.get('/', requirePermission('settings.view'), listSettings);
router.get('/group/:group', requirePermission('settings.view'), getSettingsByGroup);
router.get('/:key', requirePermission('settings.view'), getSetting);
router.post('/', requirePermission('settings.update'), validate({ body: settingCreateSchema }), createSetting);
router.put('/:key', requirePermission('settings.update'), validate({ body: settingUpdateSchema }), updateSetting);
router.delete('/:key', requirePermission('settings.update'), deleteSetting);

export default router;
