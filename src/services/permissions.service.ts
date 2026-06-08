import { adminRoles, applyRolePermissions, permissions as allPermissions, type PermissionKey } from '../config/permissions';
import { supabase } from '../config/supabase';
import type { AdminRole } from '../types';

/**
 * Loads the effective role→permission map from the `role_permissions` table
 * into the in-memory store used by the permission middleware. Roles with no
 * rows keep their built-in defaults (prevents lockout on an unseeded database).
 * Best-effort: any failure leaves the safe defaults in place.
 */
export const loadRolePermissions = async (): Promise<void> => {
  try {
    const { data, error } = await supabase.from('role_permissions').select('role,permission_key');
    if (error || !data) return;

    const byRole = new Map<string, PermissionKey[]>();
    for (const row of data) {
      const key = String((row as { permission_key: unknown }).permission_key);
      if (!allPermissions.includes(key as PermissionKey)) continue; // ignore stale/unknown keys
      const role = String((row as { role: unknown }).role);
      const list = byRole.get(role) ?? [];
      list.push(key as PermissionKey);
      byRole.set(role, list);
    }

    for (const role of adminRoles) {
      const perms = byRole.get(role);
      if (perms && perms.length > 0) applyRolePermissions(role as AdminRole, perms);
    }
  } catch {
    // keep defaults
  }
};
