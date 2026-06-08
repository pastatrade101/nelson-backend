import { permissions, rolePermissions } from '../config/permissions';
import { asyncHandler } from '../utils/async-handler';
import { sendSuccess } from '../utils/api-response';

export const listPermissions = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Permissions fetched successfully.', {
    permissions,
    rolePermissions
  });
});
