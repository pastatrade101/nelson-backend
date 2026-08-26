import { randomUUID } from 'node:crypto';
import { supabase } from '../config/supabase';
import { toWaId } from './whatsapp-client.service';

/**
 * Ties a WhatsApp phone number to the platform's existing records.
 *
 * The rule from the spec that matters most here: do not create a disconnected
 * WhatsApp CRM. A conversation is an ai_conversations row with channel
 * 'whatsapp'; its turns are ai_messages; a lead is still a booking_request.
 * This service only resolves identity and writes those existing shapes.
 */

export type WhatsAppContact = {
  id: string;
  wa_id: string;
  phone_e164: string | null;
  profile_name: string | null;
  whatsapp_opt_in: boolean;
  last_inbound_at: string | null;
  blocked: boolean;
};

/** Digits-only comparison — stored numbers vary in punctuation and +. */
const phoneMatches = (candidate: unknown, waId: string): boolean =>
  typeof candidate === 'string' && candidate.replace(/[^0-9]/g, '').endsWith(waId.slice(-9));

/**
 * Find or create the contact for a wa_id.
 *
 * An inbound message is itself the strongest possible opt-in signal — the
 * person chose to message the business — so a contact created this way is
 * recorded as opted in, with the source noted.
 */
export const upsertContact = async (
  waId: string,
  profileName?: string,
  inbound = false
): Promise<WhatsAppContact> => {
  const { data: existing } = await supabase
    .from('whatsapp_contacts')
    .select('*')
    .eq('wa_id', waId)
    .maybeSingle();

  const now = new Date().toISOString();

  if (existing) {
    const patch: Record<string, unknown> = { updated_at: now };
    if (profileName && profileName !== existing.profile_name) patch.profile_name = profileName;
    if (inbound) {
      patch.last_inbound_at = now;
      if (!existing.whatsapp_opt_in) {
        patch.whatsapp_opt_in = true;
        patch.whatsapp_opt_in_at = now;
        patch.whatsapp_opt_in_source = 'inbound_message';
      }
    }
    const { data } = await supabase
      .from('whatsapp_contacts')
      .update(patch)
      .eq('id', existing.id)
      .select('*')
      .single();
    return (data ?? existing) as WhatsAppContact;
  }

  const { data, error } = await supabase
    .from('whatsapp_contacts')
    .insert({
      wa_id: waId,
      phone_e164: `+${waId}`,
      profile_name: profileName ?? null,
      whatsapp_opt_in: inbound,
      whatsapp_opt_in_at: inbound ? now : null,
      whatsapp_opt_in_source: inbound ? 'inbound_message' : null,
      last_inbound_at: inbound ? now : null
    })
    .select('*')
    .single();

  if (error) {
    // Concurrent webhooks can race on the unique wa_id; the loser re-reads.
    const { data: raced } = await supabase.from('whatsapp_contacts').select('*').eq('wa_id', waId).maybeSingle();
    if (raced) return raced as WhatsAppContact;
    throw error;
  }
  return data as WhatsAppContact;
};

/**
 * The conversation this contact belongs to, reusing whatever the platform
 * already knows about them.
 *
 * Order matters: an open WhatsApp thread first, then a website assistant
 * conversation started by the same phone number — that is what carries the
 * traveller's context across the handoff so they never re-explain their trip —
 * then a lead. Only if none of that exists is a new conversation opened.
 */
export const resolveConversation = async (contact: WhatsAppContact): Promise<string> => {
  const { data: open } = await supabase
    .from('ai_conversations')
    .select('id')
    .eq('whatsapp_contact_id', contact.id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open?.id) return String(open.id);

  // A website conversation from the same number: adopt it rather than starting
  // a second thread, so the assistant's context follows the traveller.
  const { data: candidates } = await supabase
    .from('ai_conversations')
    .select('id, visitor_phone, created_at')
    .not('visitor_phone', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);

  const adopted = (candidates ?? []).find((row) => phoneMatches(row.visitor_phone, contact.wa_id));
  if (adopted?.id) {
    await supabase
      .from('ai_conversations')
      .update({ whatsapp_contact_id: contact.id, channel: 'whatsapp', updated_at: new Date().toISOString() })
      .eq('id', adopted.id);
    return String(adopted.id);
  }

  // A lead with this phone number, so the conversation opens already attached.
  const { data: leads } = await supabase
    .from('booking_requests')
    .select('id, phone, full_name, country, lead_context')
    .not('phone', 'is', null)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(200);
  const lead = (leads ?? []).find((row) => phoneMatches(row.phone, contact.wa_id));

  const { data: created, error } = await supabase
    .from('ai_conversations')
    .insert({
      channel: 'whatsapp',
      status: 'in_progress',
      whatsapp_contact_id: contact.id,
      visitor_name: contact.profile_name ?? lead?.full_name ?? null,
      visitor_phone: contact.phone_e164 ?? `+${contact.wa_id}`,
      visitor_country: lead?.country ?? null,
      booking_request_id: lead?.id ?? null,
      lead_context: lead?.lead_context ?? {},
      consent_given: true,
      consent_at: new Date().toISOString()
    })
    .select('id')
    .single();
  if (error) throw error;
  return String(created.id);
};

/**
 * Record transactional WhatsApp consent given on a form, with its evidence.
 *
 * Two rules this must never break. Supplying a phone number is not consent —
 * only an explicit tick is, which is why `granted` is passed in rather than
 * inferred from the number being present. And an unticked box is the absence
 * of new consent, not a withdrawal of consent given earlier by another route,
 * so it never downgrades an existing opt-in; revoking is a deliberate act that
 * belongs elsewhere.
 *
 * The first grant is the evidence of record: a later tick does not overwrite
 * when or how permission was originally obtained.
 */
export const recordTransactionalConsent = async (
  phone: string | null | undefined,
  source: string,
  granted: boolean
): Promise<void> => {
  const waId = toWaId(String(phone ?? ''));
  if (!waId) return;

  const now = new Date().toISOString();
  const { data: existing } = await supabase
    .from('whatsapp_contacts')
    .select('id, whatsapp_opt_in')
    .eq('wa_id', waId)
    .maybeSingle();

  if (!existing) {
    await supabase.from('whatsapp_contacts').insert({
      wa_id: waId,
      phone_e164: `+${waId}`,
      whatsapp_opt_in: granted,
      whatsapp_opt_in_at: granted ? now : null,
      whatsapp_opt_in_source: granted ? source : null
    });
    return;
  }

  if (granted && !existing.whatsapp_opt_in) {
    await supabase
      .from('whatsapp_contacts')
      .update({ whatsapp_opt_in: true, whatsapp_opt_in_at: now, whatsapp_opt_in_source: source, updated_at: now })
      .eq('id', existing.id);
  }
};

/** Append a turn to the shared conversation history. */
export const recordConversationMessage = async (
  conversationId: string,
  role: 'user' | 'assistant' | 'agent',
  content: string,
  metadata: Record<string, unknown> = {}
): Promise<string | null> => {
  const { data } = await supabase
    .from('ai_messages')
    .insert({ conversation_id: conversationId, role, content, metadata: { ...metadata, channel: 'whatsapp' } })
    .select('id')
    .single();
  return data?.id ? String(data.id) : null;
};

export type UntransportedMessage = {
  contactId: string;
  conversationId: string;
  aiMessageId: string | null;
  /** 'failed' = Meta refused it. 'skipped' = we refused it before calling Meta. */
  status: 'failed' | 'skipped';
  messageType: 'text' | 'template';
  templateName?: string | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  skippedReason?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * The transport row for a message that never reached the traveller.
 *
 * Previously these left nothing at all — no row, no reason — so an agent whose
 * send was refused saw an error once and the thread showed no trace of the
 * attempt. The row is the evidence that something was tried and why it did not
 * land; it must never be mistaken for one that did.
 *
 * wa_message_id is NOT NULL UNIQUE, because that column is what makes webhook
 * processing idempotent, so a message Meta never issued an id for needs a local
 * stand-in. The `local:` prefix cannot collide with a wamid and cannot be
 * matched by any status callback, but it is still only an id: `status` is the
 * only thing that says whether Meta ever had the message.
 *
 * Best-effort by design — losing the record of a failure must not become a
 * second failure on top of the one being recorded.
 */
export const recordUntransported = async (message: UntransportedMessage): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await supabase.from('whatsapp_messages').insert({
    wa_message_id: `local:${randomUUID()}`,
    contact_id: message.contactId,
    conversation_id: message.conversationId,
    ai_message_id: message.aiMessageId,
    direction: 'outbound',
    message_type: message.messageType,
    status: message.status,
    template_name: message.templateName ?? null,
    error_code: message.errorCode ?? null,
    error_message: message.errorMessage ?? null,
    skipped_reason: message.skippedReason ?? null,
    // sent_at stays null on purpose: nothing was sent.
    failed_at: message.status === 'failed' ? now : null,
    payload: message.payload ?? {}
  });

  if (error) {
    // Shape only — never the traveller's message or number.
    console.error('[whatsapp] could not record an untransported message', {
      status: message.status,
      error: (error as { message?: string }).message ?? 'unknown'
    });
  }
};

/** Look up a contact for an outbound send. */
export const contactByPhone = async (phone: string): Promise<WhatsAppContact | null> => {
  const { data } = await supabase
    .from('whatsapp_contacts')
    .select('*')
    .eq('wa_id', toWaId(phone))
    .maybeSingle();
  return (data as WhatsAppContact | null) ?? null;
};
