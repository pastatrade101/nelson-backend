import bcrypt from 'bcryptjs';
import { supabase } from '../config/supabase';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { listRecords, getRecordById, softDeleteRecord } from '../utils/supabase-helpers';
import { safeAudit } from '../services/audit.service';

const select = 'id,full_name,email,phone,avatar_url,role,is_active,last_login_at,created_at,updated_at,deleted_at';

const isSuperAdmin = (req: { user?: { role?: string } }) => req.user?.role === 'super_admin';

/** Counts active, non-deleted super admins, optionally excluding one id. */
const countActiveSuperAdmins = async (excludeId?: string) => {
  let query = supabase
    .from('admin_users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'super_admin')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (excludeId) query = query.neq('id', excludeId);

  const { count } = await query;
  return count ?? 0;
};

export const listUsers = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'admin_users',
    select,
    searchColumns: ['full_name', 'email', 'phone'],
    filters: ['role', 'is_active']
  });
});

export const getUser = asyncHandler(async (req, res) => getRecordById(res, 'admin_users', req.params.id, select));

export const createUser = asyncHandler(async (req, res) => {
  const { password, ...body } = req.body;

  // Only a super admin may create another super admin (prevents privilege escalation).
  if (body.role === 'super_admin' && !isSuperAdmin(req)) {
    throw new AppError('Only a super admin can create a super admin account.', 403);
  }

  const password_hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('admin_users')
    .insert({ ...body, email: String(body.email).toLowerCase(), password_hash })
    .select(select)
    .single();

  if (error) {
    if (String(error.code) === '23505') throw new AppError('An admin with that email already exists.', 409);
    throw new AppError('Unable to create admin user.', 500, [error]);
  }

  await safeAudit({ action: 'create', entityId: data.id, entityType: 'admin_users', newData: data, req });

  return sendSuccess(res, 'Admin user created successfully.', data, 201);
});

export const updateUser = asyncHandler(async (req, res) => {
  const { password, ...body } = req.body;
  const payload: Record<string, unknown> = { ...body };

  const { data: previous } = await supabase.from('admin_users').select(select).eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Admin user not found.', 404);

  // Editing a super admin requires super admin.
  if (previous.role === 'super_admin' && !isSuperAdmin(req)) {
    throw new AppError('Only a super admin can update a super admin account.', 403);
  }
  // Granting the super admin role requires super admin.
  if (payload.role === 'super_admin' && !isSuperAdmin(req)) {
    throw new AppError('Only a super admin can grant the super admin role.', 403);
  }

  // Protect the last active super admin from being demoted or deactivated.
  const demoting = payload.role !== undefined && payload.role !== 'super_admin' && previous.role === 'super_admin';
  const deactivating = payload.is_active === false && previous.is_active && previous.role === 'super_admin';
  if ((demoting || deactivating) && (await countActiveSuperAdmins(req.params.id)) === 0) {
    throw new AppError('You cannot demote or deactivate the last active super admin.', 422);
  }

  if (payload.email) payload.email = String(payload.email).toLowerCase();
  if (password) payload.password_hash = await bcrypt.hash(password, 12);

  const { data, error } = await supabase
    .from('admin_users')
    .update(payload)
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) {
    if (String(error.code) === '23505') throw new AppError('An admin with that email already exists.', 409);
    throw new AppError('Unable to update admin user.', 500, [error]);
  }

  await safeAudit({ action: 'update', entityId: req.params.id, entityType: 'admin_users', oldData: previous, newData: data, req });

  return sendSuccess(res, 'Admin user updated successfully.', data);
});

export const updateUserStatus = asyncHandler(async (req, res) => {
  const isActive = Boolean(req.body.is_active);

  const { data: previous } = await supabase.from('admin_users').select(select).eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Admin user not found.', 404);

  if (previous.role === 'super_admin' && !isSuperAdmin(req)) {
    throw new AppError('Only a super admin can change a super admin account.', 403);
  }

  if (!isActive && previous.is_active && previous.role === 'super_admin' && (await countActiveSuperAdmins(req.params.id)) === 0) {
    throw new AppError('You cannot deactivate the last active super admin.', 422);
  }

  const { data, error } = await supabase
    .from('admin_users')
    .update({ is_active: isActive })
    .eq('id', req.params.id)
    .select(select)
    .single();

  if (error) throw new AppError('Unable to update admin user status.', 500, [error]);

  await safeAudit({ action: isActive ? 'activate' : 'deactivate', entityId: req.params.id, entityType: 'admin_users', oldData: previous, newData: data, req });

  return sendSuccess(res, `Admin user ${isActive ? 'activated' : 'deactivated'} successfully.`, data);
});

export const updateUserPassword = asyncHandler(async (req, res) => {
  const { data: previous } = await supabase.from('admin_users').select('id,role,email,full_name').eq('id', req.params.id).maybeSingle();
  if (!previous) throw new AppError('Admin user not found.', 404);

  if (previous.role === 'super_admin' && !isSuperAdmin(req)) {
    throw new AppError('Only a super admin can change a super admin password.', 403);
  }

  const password_hash = await bcrypt.hash(req.body.password, 12);

  const { error } = await supabase.from('admin_users').update({ password_hash }).eq('id', req.params.id);
  if (error) throw new AppError('Unable to update password.', 500, [error]);

  // Audit the action — never log the password or hash.
  await safeAudit({ action: 'password_change', entityId: req.params.id, entityType: 'admin_users', req });

  return sendSuccess(res, 'Password updated successfully.');
});

export const deleteUser = asyncHandler(async (req, res) => {
  const { data: user } = await supabase.from('admin_users').select('id,role,is_active').eq('id', req.params.id).maybeSingle();
  if (!user) throw new AppError('Admin user not found.', 404);

  if (user.role === 'super_admin' && !isSuperAdmin(req)) {
    throw new AppError('Only a super admin can delete a super admin account.', 403);
  }

  if (req.user?.sub === req.params.id) {
    throw new AppError('You cannot delete your own account.', 422);
  }

  if (user.role === 'super_admin' && user.is_active && (await countActiveSuperAdmins(req.params.id)) === 0) {
    throw new AppError('You cannot delete the last active super admin.', 422);
  }

  return softDeleteRecord(res, 'admin_users', req.params.id, req);
});
