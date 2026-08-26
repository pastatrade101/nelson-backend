import { supabase } from '../config/supabase';
import {
  canSendSessionMessage,
  describeSendFailure,
  sendTemplateMessage,
  sendTextMessage,
  toWaId,
  whatsappSendingAvailable
} from './whatsapp-client.service';
import {
  recordConversationMessage,
  recordUntransported,
  resolveConversation,
  upsertContact
} from './whatsapp-inbox.service';
import { emailLayout, escapeHtml, isEmailConfigured, sendEmail } from './email.service';
import { recipientFor } from './notification.service';

/**
 * Event-driven notifications (§14).
 *
 * Business code emits an event and stops caring how it reaches anyone. The
 * service decides which channels an event belongs on and each channel decides
 * whether it is allowed to send:
 *
 *   BUSINESS EVENT -> notification service -> [ whatsapp | email | email (staff) ]
 *
 * The split is about what each medium is good at, not about replacing one with
 * the other. WhatsApp is for immediacy — an acknowledgement, a link, a
 * reminder, something read on a phone within minutes. Email is the formal
 * record: it survives, it forwards, it can carry detail, and it arrives whether
 * or not the traveller ever opted into WhatsApp. Important events use both, and
 * the two are deliberately independent — the 24-hour WhatsApp window closing
 * must never mean the traveller hears nothing.
 *
 * Separate from notification.service.ts, which is the existing per-booking
 * email + HubSpot path and stays exactly as it is. That one fires for a
 * specific thing that happened; this one is the generic outbox any channel
 * subscribes to. LEAD_CREATED is WhatsApp-only here precisely because
 * notification.service.ts already emails on booking creation — routing it
 * through both would send the traveller the same thing twice.
 */

export type NotificationEventType =
  | 'LEAD_CREATED'
  | 'QUOTATION_READY'
  | 'QUOTATION_UPDATED'
  | 'QUOTATION_ACCEPTED'
  | 'BOOKING_CONFIRMED';

export type Channel = 'whatsapp' | 'email' | 'email_staff';

/**
 * Which channels each event belongs on.
 *
 * Declared here rather than at the call sites, so "how does a traveller hear
 * about a new quotation" is one table to read and one place to change.
 */
const CHANNEL_POLICY: Record<NotificationEventType, Channel[]> = {
  // Email is handled by notification.service.ts on booking creation.
  LEAD_CREATED: ['whatsapp'],
  QUOTATION_READY: ['whatsapp', 'email'],
  QUOTATION_UPDATED: ['whatsapp', 'email'],
  QUOTATION_ACCEPTED: ['whatsapp', 'email', 'email_staff'],
  BOOKING_CONFIRMED: ['whatsapp', 'email']
};

/**
 * Email content as plain text. Callers never write HTML: the channel escapes
 * every line and wraps it in the shared layout, so a traveller's own name or
 * note cannot smuggle markup into an email we send about them.
 */
export type EmailContent = {
  subject: string;
  heading: string;
  /** One paragraph per entry. */
  lines: string[];
  cta?: { label: string; url: string };
  replyTo?: string;
};

export type NotificationEvent = {
  type: NotificationEventType;
  entityType?: string;
  entityId?: string;
  /** WhatsApp recipient. No number means nothing to send — recorded as skipped. */
  phone?: string | null;
  /** Email recipient for the traveller-facing channel. */
  email?: string | null;
  /** Body for a WhatsApp session message, and the fallback if no template is mapped. */
  message: string;
  /** Internal template key; resolved through whatsapp_templates. */
  templateKey?: string;
  templateParameters?: string[];
  /** The traveller's email. Required for any event whose policy includes 'email'. */
  emailContent?: EmailContent;
  /** The team's copy, routed to the enquiry inbox rather than to the traveller. */
  staffEmailContent?: EmailContent;
  /**
   * Makes the event idempotent. Two emits with the same key send once — a
   * retry, a double-click or a replayed webhook collides instead of messaging
   * the traveller twice. Each channel gets its own claim off this key, so a
   * WhatsApp failure never suppresses the email.
   */
  dedupeKey: string;
  /**
   * Marketing sends need explicit marketing consent; transactional ones ride
   * on the WhatsApp opt-in the traveller gave by messaging us.
   */
  marketing?: boolean;
};

type Outcome = { status: 'sent' | 'skipped' | 'failed'; detail?: string };

export type EmitResult = Outcome & { channels: Partial<Record<Channel, Outcome>> };

/**
 * Take ownership of one channel's attempt at this event.
 *
 * Idempotent on success, retryable on everything else. A delivery that was
 * skipped or failed never reached the traveller, so locking it forever would
 * mean an agent who fixes the cause — grants consent, configures email, gets a
 * template approved — can never send the thing they were trying to send. Only
 * a genuine send is final.
 */
const claim = async (event: NotificationEvent, channel: Channel): Promise<string | null> => {
  // Per channel, so one medium being unavailable never blocks the other.
  const dedupeKey = `${event.dedupeKey}:${channel}`;
  const payload = {
    message: event.message,
    template_key: event.templateKey ?? null,
    parameters: event.templateParameters ?? []
  };

  const { data, error } = await supabase
    .from('notification_events')
    .insert({
      event_type: event.type,
      entity_type: event.entityType ?? null,
      entity_id: event.entityId ?? null,
      channel,
      dedupe_key: dedupeKey,
      payload
    })
    .select('id')
    .single();

  if (!error) return String(data.id);
  if ((error as { code?: string }).code !== '23505') throw error;

  // Already attempted on this channel. Retry unless it actually went.
  const { data: existing } = await supabase
    .from('notification_events')
    .select('id, status')
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();

  if (!existing || existing.status === 'sent') return null;

  await supabase
    .from('notification_events')
    .update({ status: 'pending', detail: null, payload, created_at: new Date().toISOString() })
    .eq('id', existing.id);

  return String(existing.id);
};

const settle = async (id: string, outcome: Outcome) => {
  await supabase
    .from('notification_events')
    .update({
      status: outcome.status,
      detail: outcome.detail ?? null,
      sent_at: outcome.status === 'sent' ? new Date().toISOString() : null
    })
    .eq('id', id);
};

/**
 * Resolve an internal key to a template Meta will actually accept.
 *
 * Approved only. A registered-but-unapproved row is a name WhatsApp Manager
 * has never seen, so attempting it would earn an opaque API error; treating it
 * as "no template" instead means the event is skipped with a reason an admin
 * can read and act on.
 */
const templateFor = async (key: string) => {
  const { data } = await supabase
    .from('whatsapp_templates')
    .select('meta_template_name, language, variables')
    .eq('internal_key', key)
    .eq('status', 'approved')
    .maybeSingle();
  return data as { meta_template_name: string; language: string; variables: unknown } | null;
};

/**
 * Meta rejects a template whose placeholder count does not match the
 * parameters supplied, so the registry's own record of its variables is
 * checked first. This is what keeps the layer generic: mapping an event to a
 * template that expects a different number of values fails here, loudly and
 * before it reaches a traveller, rather than being discovered in production.
 */
const parameterMismatch = (variables: unknown, parameters: string[]): string | null => {
  if (!Array.isArray(variables) || !variables.length) return null;
  return variables.length === parameters.length
    ? null
    : `Template expects ${variables.length} parameter${variables.length === 1 ? '' : 's'} (${variables.join(', ')}) but ${parameters.length} were supplied.`;
};

/**
 * Deliver over WhatsApp, respecting consent and the messaging rules.
 *
 * Inside the 24-hour service window a plain message is allowed. Outside it,
 * only an approved template — and if no template is mapped yet, the event is
 * recorded as skipped with the reason rather than attempted and failed. That
 * keeps the platform on the right side of Meta's rules by construction.
 *
 * Every refusal made once a contact is known leaves a row in the thread. A
 * traveller's thread going quiet with no explanation is what an agent cannot
 * act on; "we did not send this, and here is why" is what they can.
 */
const deliverWhatsApp = async (event: NotificationEvent): Promise<Outcome> => {
  // Deliberately no row: an unconfigured server is an environment problem, not
  // something that happened to this traveller, and writing it to every thread
  // would bury the refusals that are.
  if (!(await whatsappSendingAvailable())) return { status: 'skipped', detail: 'WhatsApp is not configured.' };
  if (!event.phone) return { status: 'skipped', detail: 'No WhatsApp number for this recipient.' };

  const waId = toWaId(event.phone);
  if (!waId) return { status: 'skipped', detail: 'Unusable phone number.' };

  const contact = await upsertContact(waId);

  /**
   * From here there is a contact, so there is a thread to write to. Recording
   * is best-effort: the outcome the caller sees must not change because the
   * note about it could not be stored.
   */
  const record = async (
    status: 'failed' | 'skipped',
    detail: string,
    attempted: { messageType: 'text' | 'template'; templateName?: string | null; errorCode?: string | null }
  ): Promise<Outcome> => {
    try {
      const conversationId = await resolveConversation(contact);
      const aiMessageId = await recordConversationMessage(conversationId, 'assistant', event.message, {
        notification_event: event.type,
        // What the thread must not imply is that the traveller saw this.
        delivery_status: status,
        delivery_detail: detail
      });
      await recordUntransported({
        contactId: contact.id,
        conversationId,
        aiMessageId,
        status,
        messageType: attempted.messageType,
        templateName: attempted.templateName ?? null,
        errorCode: attempted.errorCode ?? null,
        errorMessage: status === 'failed' ? detail : null,
        skippedReason: status === 'skipped' ? detail : null,
        payload: { notification_event: event.type }
      });
    } catch (error) {
      console.error('[notifications] could not record an undelivered WhatsApp message', {
        type: event.type,
        status,
        error: error instanceof Error ? error.message : 'unknown'
      });
    }
    return { status, detail };
  };

  const skipped = (detail: string, messageType: 'text' | 'template' = 'text') =>
    record('skipped', detail, { messageType });

  if (contact.blocked) return skipped('Contact is blocked.');
  if (!contact.whatsapp_opt_in) return skipped('No WhatsApp opt-in on record.');
  if (event.marketing) {
    const { data } = await supabase.from('whatsapp_contacts').select('marketing_opt_in').eq('id', contact.id).maybeSingle();
    if (!data?.marketing_opt_in) return skipped('No marketing opt-in on record.');
  }

  const inWindow = canSendSessionMessage(contact.last_inbound_at);
  const template = event.templateKey ? await templateFor(event.templateKey) : null;

  // Both set before the call rather than after, so the catch can tell what was
  // attempted and whether Meta ever took it.
  let usedTemplate: string | null = null;
  let waMessageId = '';

  try {
    if (inWindow) {
      ({ waMessageId } = await sendTextMessage(waId, event.message));
    } else if (template) {
      const parameters = event.templateParameters ?? [];
      const mismatch = parameterMismatch(template.variables, parameters);
      if (mismatch) return await skipped(mismatch, 'template');

      usedTemplate = template.meta_template_name;
      ({ waMessageId } = await sendTemplateMessage(waId, template.meta_template_name, template.language, parameters));
    } else {
      return await skipped(
        'Outside the 24-hour window and no approved WhatsApp template is configured for this event.'
      );
    }

    // Mirror it into the conversation so the inbox shows what the traveller
    // received — an automated message is still part of the thread.
    const conversationId = await resolveConversation(contact);
    const aiMessageId = await recordConversationMessage(conversationId, 'assistant', event.message, {
      wa_message_id: waMessageId,
      notification_event: event.type
    });

    await supabase.from('whatsapp_messages').insert({
      wa_message_id: waMessageId,
      contact_id: contact.id,
      conversation_id: conversationId,
      ai_message_id: aiMessageId,
      direction: 'outbound',
      message_type: usedTemplate ? 'template' : 'text',
      // Meta holds the request; only a webhook may say a phone holds the message.
      status: 'accepted',
      template_name: usedTemplate,
      sent_at: new Date().toISOString(),
      payload: { notification_event: event.type }
    });

    return { status: 'sent' };
  } catch (error) {
    // A wamid already in hand means Meta took the message and it was the
    // bookkeeping underneath that failed. Calling that a failed send would be
    // the same untruth in the other direction, and would re-send on retry.
    if (waMessageId) {
      console.error('[notifications] WhatsApp accepted but the record could not be written', {
        type: event.type,
        error: error instanceof Error ? error.message : 'unknown'
      });
      return { status: 'sent', detail: 'Sent, but the conversation record could not be written.' };
    }

    const failure = describeSendFailure(error);
    return await record('failed', failure.message, {
      messageType: usedTemplate ? 'template' : 'text',
      templateName: usedTemplate,
      errorCode: failure.code
    });
  }
};

/**
 * Deliver over email, through the Resend/SMTP transport the platform already
 * uses. Everything the caller supplied is plain text and is escaped here.
 */
const deliverEmail = async (to: string | null | undefined, content: EmailContent | undefined): Promise<Outcome> => {
  if (!content) return { status: 'skipped', detail: 'No email content supplied for this event.' };
  if (!isEmailConfigured()) return { status: 'skipped', detail: 'Email is not configured.' };
  if (!to || !to.includes('@')) return { status: 'skipped', detail: 'No email address for this recipient.' };

  try {
    const body = content.lines
      .filter(Boolean)
      .map((line) => `<p style="margin:0 0 12px">${escapeHtml(line).replace(/\n/g, '<br />')}</p>`)
      .join('');

    const cta = content.cta ? { label: escapeHtml(content.cta.label), url: escapeHtml(content.cta.url) } : undefined;

    const delivered = await sendEmail({
      to,
      replyTo: content.replyTo,
      subject: content.subject,
      html: emailLayout(escapeHtml(content.heading), body, cta),
      text: `${content.heading}\n\n${content.lines.join('\n\n')}${content.cta ? `\n\n${content.cta.label}: ${content.cta.url}` : ''}`
    });

    return delivered ? { status: 'sent' } : { status: 'failed', detail: 'The email provider rejected the message.' };
  } catch (error) {
    return { status: 'failed', detail: error instanceof Error ? error.message : 'Send failed.' };
  }
};

const deliver = async (event: NotificationEvent, channel: Channel): Promise<Outcome> => {
  if (channel === 'whatsapp') return deliverWhatsApp(event);
  if (channel === 'email') {
    // Marketing by email needs a consent record the platform does not keep yet,
    // so it is refused rather than assumed.
    if (event.marketing) return { status: 'skipped', detail: 'Email marketing consent is not tracked yet.' };
    return deliverEmail(event.email, event.emailContent);
  }

  // The team's copy. Routed through the same setting that already decides
  // where enquiries land, so there is one inbox to configure, not two.
  const recipient = await recipientFor(event.type.toLowerCase());
  return deliverEmail(recipient, event.staffEmailContent);
};

/**
 * Emit a business event.
 *
 * Never throws: a notification failing must not roll back the thing that
 * happened. Every channel is attempted independently and the outcome of each
 * is recorded, so the admin can see what was sent, skipped or failed, and why.
 *
 * The aggregate status answers the only question callers actually have — did
 * this reach the traveller at all — so a quotation counts as delivered when
 * the email lands even if WhatsApp had nothing to send it through.
 */
export const emitNotification = async (event: NotificationEvent): Promise<EmitResult> => {
  const channels: Partial<Record<Channel, Outcome>> = {};

  // A channel that cannot deliver is dropped rather than attempted, so turning
  // email off leaves no trail of "skipped: disabled" rows and the reported
  // reason is whatever the remaining channel actually said.
  const policy = (CHANNEL_POLICY[event.type] ?? ['whatsapp']).filter((channel) =>
    channel === 'whatsapp' ? true : isEmailConfigured()
  );

  for (const channel of policy) {
    try {
      const id = await claim(event, channel);
      if (!id) {
        // Only reachable when a previous attempt genuinely delivered.
        channels[channel] = { status: 'sent', detail: 'Already delivered for this event.' };
        continue;
      }

      const outcome = await deliver(event, channel);
      await settle(id, outcome);
      channels[channel] = outcome;
    } catch (error) {
      // Log the shape only — never the traveller's message, number or address.
      console.error('[notifications] channel failed', {
        type: event.type,
        channel,
        error: error instanceof Error ? error.message : 'unknown'
      });
      channels[channel] = { status: 'failed', detail: 'Notification could not be recorded.' };
    }
  }

  const traveller = (['whatsapp', 'email'] as const).map((c) => channels[c]).filter(Boolean) as Outcome[];
  const sent = traveller.filter((o) => o.status === 'sent');

  if (sent.length) {
    return { status: 'sent', channels };
  }

  const failed = traveller.find((o) => o.status === 'failed');
  // Both channels commonly refuse for the same reason; saying it twice reads
  // like two problems.
  const reasons = [...new Set(traveller.map((o) => o.detail).filter(Boolean))];
  return {
    status: failed ? 'failed' : 'skipped',
    detail: reasons.join(' · ') || 'Nothing to send.',
    channels
  };
};

/** Which traveller-facing channels actually delivered, for the audit trail. */
export const deliveredVia = (result: EmitResult): string =>
  (['whatsapp', 'email'] as const).filter((c) => result.channels[c]?.status === 'sent').join(',');
