import { env } from '../config/env';
import { supabase } from '../config/supabase';

// ----------------------------------------------------------------------------
// Privacy / data retention (§27). Purge anonymous AI conversations after
// AI_DATA_RETENTION_DAYS, but KEEP anything that became a real lead — linked to
// a booking request, flagged for handoff, or with captured contact details.
// Deletes cascade to ai_messages / ai_lead_context / ai_tool_calls /
// tour_match_results via their FKs. Also supports GDPR delete-on-request.
// ----------------------------------------------------------------------------

export type PurgeResult = { purged: number; cutoff: string; retentionDays: number };

export const purgeAnonymousConversations = async (): Promise<PurgeResult> => {
  const retentionDays = env.AI_DATA_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from('ai_conversations')
      .delete()
      .lt('created_at', cutoff)
      .is('booking_request_id', null) // keep anything that became a booking request
      .is('visitor_email', null) // keep captured leads
      .is('visitor_phone', null)
      .eq('handoff_required', false) // keep anything escalated to a human
      .select('id');

    if (error) return { purged: 0, cutoff, retentionDays };
    return { purged: data?.length ?? 0, cutoff, retentionDays };
  } catch {
    return { purged: 0, cutoff, retentionDays };
  }
};

/** GDPR delete-on-request: remove a single conversation and all its data. */
export const deleteConversation = async (conversationId: string): Promise<{ deleted: boolean }> => {
  try {
    const { error } = await supabase.from('ai_conversations').delete().eq('id', conversationId);
    return { deleted: !error };
  } catch {
    return { deleted: false };
  }
};
