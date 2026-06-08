import { asyncHandler } from '../utils/async-handler';
import { getRecordById, listRecords } from '../utils/supabase-helpers';

const select = '*, admin_users(full_name,email,role)';

export const listAuditLogs = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'audit_logs',
    select,
    searchColumns: ['action', 'entity_type', 'entity_id'],
    filters: ['admin_user_id', 'entity_type'],
    softDelete: false
  });
});

export const getAuditLog = asyncHandler(async (req, res) => getRecordById(res, 'audit_logs', req.params.id, select));
