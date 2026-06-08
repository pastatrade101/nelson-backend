import type { Request } from 'express';
import { supabase } from '../config/supabase';

type AuditInput = {
  action: string;
  entityId?: string | null;
  entityType: string;
  newData?: unknown;
  oldData?: unknown;
  req?: Request;
};

export const logAuditEvent = async ({ action, entityId, entityType, newData, oldData, req }: AuditInput) => {
  if (!req?.user) return;

  await supabase.from('audit_logs').insert({
    action,
    admin_user_id: req.user.sub,
    entity_id: entityId ?? null,
    entity_type: entityType,
    ip_address: req.ip,
    new_data: newData ?? null,
    old_data: oldData ?? null,
    user_agent: req.get('user-agent') ?? null
  });
};

export const safeAudit = async (input: AuditInput) => {
  try {
    await logAuditEvent(input);
  } catch {
    // Audit logging should never break the user-facing API response.
  }
};
