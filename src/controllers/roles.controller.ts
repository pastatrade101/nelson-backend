import { adminRoles, applyRolePermissions, permissions, rolePermissions, type PermissionKey } from '../config/permissions';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { safeAudit } from '../services/audit.service';
import type { AdminRole } from '../types';

export const listRoles = asyncHandler(async (_req, res) => {
  const roles = adminRoles.map((role) => ({
    role,
    permissions: rolePermissions[role]
  }));

  return sendSuccess(res, 'Roles fetched successfully.', roles);
});

export const listPermissions = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'Permissions fetched successfully.', permissions);
});

export const updateRolePermissions = asyncHandler(async (req, res) => {
  const role = req.params.role as AdminRole;
  const nextPermissions: string[] = Array.isArray(req.body.permissions) ? req.body.permissions : [];

  // Only a super admin may change role permissions (prevents privilege escalation).
  if (req.user?.role !== 'super_admin') {
    throw new AppError('Only a super admin can update role permissions.', 403);
  }

  if (!adminRoles.includes(role)) throw new AppError('Invalid role.', 422);
  if (role === 'super_admin') throw new AppError('Super admin permissions cannot be changed.', 403);

  const invalid = nextPermissions.filter((permission) => !permissions.includes(permission as never));
  if (invalid.length) throw new AppError('Invalid permission keys.', 422, invalid);

  const previous = rolePermissions[role];

  await supabase.from('role_permissions').delete().eq('role', role);

  if (nextPermissions.length) {
    const { error } = await supabase.from('role_permissions').insert(
      nextPermissions.map((permission) => ({
        permission_key: permission,
        role
      }))
    );

    if (error) throw new AppError('Unable to update role permissions.', 500, [error]);
  }

  // Update the in-memory map so enforcement reflects the change immediately.
  applyRolePermissions(role, nextPermissions as PermissionKey[]);

  await safeAudit({
    action: 'update_permissions',
    entityType: 'role_permissions',
    entityId: role,
    oldData: { role, permissions: previous },
    newData: { role, permissions: nextPermissions },
    req
  });

  return sendSuccess(res, 'Role permissions updated successfully.', {
    role,
    permissions: nextPermissions
  });
});
