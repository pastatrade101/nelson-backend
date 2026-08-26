import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { supabase } from '../config/supabase';
import { safeAudit } from '../services/audit.service';
import { connectTransportEnabled } from '../services/makutano-connect.service';
import {
  canSendSessionMessage,
  describeSendFailure,
  markMessageRead,
  sendTemplateMessage,
  sendTextMessage,
  toWaId,
  whatsappConfig
} from '../services/whatsapp-client.service';
import type { SendResult } from '../services/whatsapp-client.service';
import { resolveWhatsAppCredentials } from '../services/whatsapp-credentials.service';
import {
  contactByPhone,
  recordConversationMessage,
  recordUntransported,
  resolveConversation,
  upsertContact
} from '../services/whatsapp-inbox.service';

// ── Webhook verification (GET) ──────────────────────────────────────────────

/**
 * Meta's subscription handshake. Echoes hub.challenge as plain text when the
 * verify token matches, and 403s otherwise — a wrong token must never look
 * like a successful subscription.
 */
export const verifyWebhook = (req: Request, res: Response) => {
  const config = whatsappConfig();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && typeof token === 'string' && config.verifyToken && token === config.verifyToken) {
    return res.status(200).type('text/plain').send(String(challenge ?? ''));
  }
  return res.status(403).type('text/plain').send('Forbidden');
};

// ── Signature validation ────────────────────────────────────────────────────

/**
 * X-Hub-Signature-256 is an HMAC-SHA256 of the raw request body keyed with the
 * App Secret. Compared with a timing-safe equal so the comparison itself
 * cannot leak the expected value byte by byte.
 */
const signatureValid = (req: Request): boolean => {
  const config = whatsappConfig();
  if (!config.appSecret) return false;

  const header = req.get('x-hub-signature-256');
  if (!header?.startsWith('sha256=')) return false;

  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!raw?.length) return false;

  const expected = createHmac('sha256', config.appSecret).update(raw).digest('hex');
  const received = header.slice('sha256='.length);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(received, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
};

// ── Inbound processing ──────────────────────────────────────────────────────

type WhatsAppValue = {
  metadata?: { phone_number_id?: string };
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<{
    id?: string;
    from?: string;
    type?: string;
    timestamp?: string;
    text?: { body?: string };
    button?: { text?: string };
    interactive?: { list_reply?: { title?: string }; button_reply?: { title?: string } };
  }>;
  statuses?: Array<{
    id?: string;
    status?: string;
    timestamp?: string;
    errors?: Array<{ code?: number; title?: string; message?: string }>;
  }>;
};

/**
 * Record the delivery before acting on it. The unique event_key means a
 * redelivered webhook — Meta retries until it gets a 200 — conflicts here and
 * returns false, so no message, conversation or business action is repeated.
 */
const claimEvent = async (key: string, type: string, payload: unknown): Promise<boolean> => {
  const { error } = await supabase
    .from('whatsapp_webhook_events')
    .insert({ event_key: key, event_type: type, payload: payload as Record<string, unknown> });
  // 23505 = unique violation = already handled.
  if (error && (error as { code?: string }).code === '23505') return false;
  if (error) throw error;
  return true;
};

/**
 * Give a claim back when the thing it was protecting never happened.
 *
 * Idempotency exists to stop a double tap messaging someone twice. It must not
 * also stop the agent trying again after a send that failed — pressing Send on
 * a message the traveller never received and being told "already sent" is the
 * same untruth this whole path is meant to remove.
 */
const releaseEvent = async (key: string): Promise<void> => {
  try {
    await supabase.from('whatsapp_webhook_events').delete().eq('event_key', key);
  } catch {
    // A stuck claim is recoverable by retrying with a fresh key; failing the
    // request over it is not.
  }
};

type TemplateRow = {
  internal_key: string;
  meta_template_name: string;
  language: string;
  variables: unknown;
  body_text: string | null;
};

/**
 * Find an approved template by either name it goes by — the internal key the
 * platform emits, or the name Meta approved. Unapproved rows never resolve, so
 * a template WhatsApp Manager has not seen cannot be sent by any route.
 */
const approvedTemplate = async (name: string): Promise<TemplateRow | null> => {
  // Meta's own naming rule, applied before the value reaches a filter string:
  // anything outside it is not a template name and must not be interpolated.
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return null;

  const { data } = await supabase
    .from('whatsapp_templates')
    .select('internal_key, meta_template_name, language, variables, body_text')
    .eq('status', 'approved')
    .or(`internal_key.eq.${name},meta_template_name.eq.${name}`)
    // Prefer the internal key, and take one: a future registration could in
    // principle use one template's internal key as another's Meta name.
    .order('internal_key', { ascending: true })
    .limit(1);

  return ((data ?? [])[0] as TemplateRow | undefined) ?? null;
};

/** What the traveller will actually read, with {{n}} filled in. */
const renderTemplate = (template: TemplateRow, parameters: string[]): string =>
  template.body_text
    ? template.body_text.replace(/\{\{(\d+)\}\}/g, (match, index) => parameters[Number(index) - 1] ?? match)
    : `[${template.meta_template_name}] ${parameters.join(' | ')}`.trim();

/** The readable text of an inbound message, whatever shape it arrived in. */
const inboundText = (message: NonNullable<WhatsAppValue['messages']>[number]): string =>
  message.text?.body ??
  message.button?.text ??
  message.interactive?.button_reply?.title ??
  message.interactive?.list_reply?.title ??
  `[${message.type ?? 'unsupported'} message]`;

/**
 * A quotation reference the traveller quoted back at us.
 *
 * The quote page prefills "…about quotation GFQ-XXXXXX", so when they tap
 * through from a quotation the code arrives with their first message. Binding
 * the thread to that quotation is what stops the reply landing in the inbox as
 * an unrelated conversation the agent has to piece together.
 */
const QUOTE_CODE = /\bGFQ-[A-Z0-9]{4,12}\b/i;

const linkQuotationMentioned = async (text: string, conversationId: string) => {
  const code = text.match(QUOTE_CODE)?.[0]?.toUpperCase();
  if (!code) return;

  try {
    const { data } = await supabase
      .from('quotations')
      .select('id, conversation_id')
      .ilike('quote_code', code)
      .is('deleted_at', null)
      .maybeSingle();

    // Only ever fills a blank. A quotation already attached to a thread keeps
    // it — someone forwarding a reference must not move another traveller's
    // quotation onto their own conversation.
    if (!data || data.conversation_id) return;

    await supabase
      .from('quotations')
      .update({ conversation_id: conversationId, updated_at: new Date().toISOString() })
      .eq('id', data.id)
      .is('conversation_id', null);
  } catch {
    // Best-effort context, never a reason to fail the webhook.
  }
};

const handleInbound = async (value: WhatsAppValue) => {
  for (const message of value.messages ?? []) {
    const waMessageId = message.id;
    const from = message.from;
    if (!waMessageId || !from) continue;

    if (!(await claimEvent(`msg:${waMessageId}`, 'message', message))) continue;

    const profileName = value.contacts?.find((c) => c.wa_id === from)?.profile?.name;
    const contact = await upsertContact(toWaId(from), profileName, true);
    const conversationId = await resolveConversation(contact);

    const content = inboundText(message);
    const aiMessageId = await recordConversationMessage(conversationId, 'user', content, {
      wa_message_id: waMessageId,
      message_type: message.type ?? 'text'
    });

    await supabase.from('whatsapp_messages').insert({
      wa_message_id: waMessageId,
      contact_id: contact.id,
      conversation_id: conversationId,
      ai_message_id: aiMessageId,
      direction: 'inbound',
      message_type: message.type ?? 'text',
      status: 'delivered',
      delivered_at: new Date().toISOString(),
      payload: message as unknown as Record<string, unknown>
    });

    await linkQuotationMentioned(content, conversationId);

    // Blue ticks. Best-effort: a failure here must not fail the webhook.
    void markMessageRead(waMessageId).catch(() => undefined);
  }
};

const STATUS_TIMESTAMPS: Record<string, string> = {
  sent: 'sent_at',
  delivered: 'delivered_at',
  read: 'read_at',
  failed: 'failed_at'
};

/**
 * Status callbacks only ever move a message forward, never backwards.
 *
 * 'pending' sits below 'accepted' because it describes a row written before
 * Meta was known to have the request. 'skipped' has no rank and needs none: a
 * skipped row carries a local id, so no callback can ever find it.
 */
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5
};

const handleStatuses = async (value: WhatsAppValue) => {
  for (const status of value.statuses ?? []) {
    const waMessageId = status.id;
    const next = status.status;
    if (!waMessageId || !next) continue;

    if (!(await claimEvent(`status:${waMessageId}:${next}`, 'status', status))) continue;

    const { data: existing } = await supabase
      .from('whatsapp_messages')
      .select('id, status')
      .eq('wa_message_id', waMessageId)
      .maybeSingle();
    if (!existing) continue;

    // Meta can deliver 'sent' after 'read' on a retry; keep the furthest state.
    if ((STATUS_RANK[next] ?? 0) < (STATUS_RANK[String(existing.status)] ?? 0) && next !== 'failed') continue;

    const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() };
    const column = STATUS_TIMESTAMPS[next];
    if (column) patch[column] = new Date(Number(status.timestamp ?? 0) * 1000 || Date.now()).toISOString();
    if (next === 'failed') {
      patch.error_code = status.errors?.[0]?.code ? String(status.errors[0].code) : null;
      patch.error_message = status.errors?.[0]?.title ?? status.errors?.[0]?.message ?? null;
    }

    await supabase.from('whatsapp_messages').update(patch).eq('id', existing.id);
  }
};

/**
 * Meta retries anything that is not a 2xx, so this answers 200 for every
 * authenticated delivery — including ones it cannot make sense of. A parsing
 * problem is ours to investigate, not a reason to make Meta retry forever.
 */
export const receiveWebhook = asyncHandler(async (req, res) => {
  if (!signatureValid(req)) {
    // 403 rather than 200: an unsigned or wrongly signed request is not from
    // Meta and must not be acknowledged as processed.
    throw new AppError('Invalid webhook signature.', 403);
  }

  const body = req.body as { entry?: Array<{ changes?: Array<{ value?: WhatsAppValue }> }> };

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      try {
        await handleInbound(value);
        await handleStatuses(value);
      } catch (error) {
        // Log the shape, never the traveller's message content.
        console.error('[whatsapp] webhook processing failed', {
          messages: value.messages?.length ?? 0,
          statuses: value.statuses?.length ?? 0,
          error: error instanceof Error ? error.message : 'unknown'
        });
      }
    }
  }

  return res.status(200).json({ received: true });
});

// ── Admin send ──────────────────────────────────────────────────────────────

/**
 * Send a message to a traveller from the admin.
 *
 * The 24-hour rule is enforced here rather than left to Meta: outside the
 * service window a free-form reply is refused with an explanation, so an agent
 * learns to use a template instead of seeing an opaque API error.
 */
export const sendMessage = asyncHandler(async (req, res) => {
  // Which account is used is resolved, not assumed: a connected business number
  // takes precedence over this deployment's own environment credentials. When
  // outbound routes through Makutano Connect, the account lives there instead
  // and no local credential is required.
  if (!connectTransportEnabled()) {
    const credentials = await resolveWhatsAppCredentials();
    if (!credentials.phoneNumberId || !credentials.accessToken) {
      throw new AppError(credentials.unavailableReason ?? 'WhatsApp is not configured on this server.', 503);
    }
  }

  const { to, body, template_name: templateName, language = 'en', parameters = [] } = req.body as {
    to?: string;
    body?: string;
    template_name?: string;
    language?: string;
    parameters?: string[];
  };

  if (!to) throw new AppError('A recipient phone number is required.', 422);
  if (!templateName && !body?.trim()) throw new AppError('A message body or template name is required.', 422);

  const waId = toWaId(to);
  const contact = await upsertContact(waId);
  if (contact.blocked) throw new AppError('This contact has been blocked.', 409);

  const useTemplate = Boolean(templateName);
  if (!useTemplate && !canSendSessionMessage(contact.last_inbound_at)) {
    // The sentence is for the agent; the code is for the composer, which has to
    // recognise this one refusal and offer the template picker rather than
    // showing the send as having merely gone wrong.
    throw new AppError(
      'This contact is outside the 24-hour customer-service window. Send an approved template instead.',
      409,
      [{ code: 'APPROVED_TEMPLATE_REQUIRED' }]
    );
  }

  // Templates go through the registry, never straight to Meta. The client may
  // name a template either way it knows it — our internal key or the name Meta
  // approved — and what actually reaches the API is always the approved one.
  let template: TemplateRow | null = null;
  if (useTemplate) {
    template = await approvedTemplate(String(templateName));
    if (!template) {
      throw new AppError(
        'That template is not registered and approved. Approve it in WhatsApp Manager and register it before sending.',
        422
      );
    }

    const expected = Array.isArray(template.variables) ? template.variables : [];
    if (expected.length !== parameters.length) {
      throw new AppError(
        `This template needs ${expected.length} value${expected.length === 1 ? '' : 's'} (${expected.join(', ')}), but ${parameters.length} were given.`,
        422
      );
    }
  }

  // A double-tap on Send must not message the traveller twice. The key comes
  // from the client because only it knows which click is a retry of which.
  const idempotencyKey = typeof req.body?.idempotency_key === 'string' ? req.body.idempotency_key.trim() : '';
  if (idempotencyKey && !(await claimEvent(`send:${idempotencyKey}`, 'outbound', { to: waId }))) {
    return sendSuccess(res, 'Already sent.', { duplicate: true });
  }

  const conversationId = await resolveConversation(contact);
  // Store what the traveller will actually read, not the template's name. The
  // thread is the record of the conversation, and "[template: booking_update]"
  // tells the next agent nothing about what was said.
  const content = template ? renderTemplate(template, parameters) : (body as string);
  const messageType = template ? 'template' : 'text';

  // The thread is resolved before the send so a refusal has somewhere to land.
  // A send that throws used to leave nothing at all behind, so the agent who
  // made it saw one error and the thread showed no trace of the attempt.
  let result: SendResult;
  try {
    result = template
      ? await sendTemplateMessage(waId, template.meta_template_name, template.language, parameters)
      : await sendTextMessage(waId, body as string);
  } catch (error) {
    const failure = describeSendFailure(error);
    try {
      const failedMessageId = await recordConversationMessage(conversationId, 'agent', content, {
        // No wa_message_id: Meta never issued one, and inventing one here would
        // make an attempt look like a send.
        delivery_status: 'failed',
        sent_by: req.user?.sub ?? null
      });
      await recordUntransported({
        contactId: contact.id,
        conversationId,
        aiMessageId: failedMessageId,
        status: 'failed',
        messageType,
        templateName: template?.meta_template_name ?? null,
        errorMessage: failure.message,
        errorCode: failure.code
      });
    } catch (recordError) {
      console.error('[whatsapp] could not record a failed send', {
        error: recordError instanceof Error ? recordError.message : 'unknown'
      });
    }
    // Nothing was delivered, so the claim has nothing left to protect. Holding
    // it would answer the agent's next attempt with "already sent".
    if (idempotencyKey) await releaseEvent(`send:${idempotencyKey}`);
    // The agent still gets Meta's own reason, unchanged.
    throw error;
  }

  const aiMessageId = await recordConversationMessage(conversationId, 'agent', content, {
    wa_message_id: result.waMessageId,
    sent_by: req.user?.sub ?? null
  });

  await supabase.from('whatsapp_messages').insert({
    wa_message_id: result.waMessageId,
    contact_id: contact.id,
    conversation_id: conversationId,
    ai_message_id: aiMessageId,
    direction: 'outbound',
    message_type: messageType,
    // Meta's own word for "I have your request" — not delivery. Only a webhook
    // may ever move this to delivered or read.
    status: 'accepted',
    template_name: template?.meta_template_name ?? null,
    sent_at: new Date().toISOString(),
    payload: result.raw
  });

  await safeAudit({
    action: 'create',
    entityId: result.waMessageId,
    entityType: 'whatsapp_messages',
    newData: { to: waId, template: template?.meta_template_name ?? null },
    req
  });

  return sendSuccess(res, 'Message sent.', {
    wa_message_id: result.waMessageId,
    conversation_id: conversationId
  });
});

/**
 * The approved templates an agent may send.
 *
 * Read from the registry rather than listed in code, so approving a fifth
 * template in WhatsApp Manager and registering it here is all it takes for the
 * inbox to offer it — no deployment, no code change.
 */
export const listTemplates = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('whatsapp_templates')
    .select('internal_key, meta_template_name, language, category, label, description, variables, body_text')
    .eq('status', 'approved')
    .order('label', { ascending: true });

  if (error) throw new AppError('Unable to load templates.', 500, [error]);
  return sendSuccess(res, 'Templates fetched successfully.', data ?? []);
});

/** Configuration health, without ever returning a credential. */
export const whatsappStatus = asyncHandler(async (_req, res) => {
  const config = whatsappConfig();
  const credentials = await resolveWhatsAppCredentials();
  return sendSuccess(res, 'WhatsApp status.', {
    configured: Boolean(credentials.phoneNumberId && credentials.accessToken),
    webhook_ready: Boolean(config.verifyToken && config.appSecret),
    graph_version: config.graphVersion,
    // Whether the sender is the business's own connected account or this
    // deployment's environment fallback. See GET /connection for the detail.
    credential_source: credentials.source,
    // Presence only — never the values.
    has_phone_number_id: Boolean(credentials.phoneNumberId),
    has_access_token: Boolean(credentials.accessToken),
    has_app_secret: Boolean(config.appSecret),
    has_business_account_id: Boolean(credentials.businessAccountId)
  });
});

/**
 * Conversation list for the inbox.
 *
 * Unread is derived — newest inbound message vs the agent's last read — rather
 * than stored as a counter, so it cannot drift away from the messages it
 * describes. One extra query for the whole page, not one per row.
 */
export const listConversations = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 40, 100);
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';

  let query = supabase
    .from('ai_conversations')
    .select(
      'id, visitor_name, visitor_phone, visitor_country, status, lead_status, handoff_state, handoff_required, ai_enabled, assigned_to, booking_request_id, conversation_summary, agent_last_read_at, updated_at, whatsapp_contact_id'
    )
    .eq('channel', 'whatsapp')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (state) query = query.eq('handoff_state', state);
  if (search) query = query.or(`visitor_name.ilike.%${search}%,visitor_phone.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) throw new AppError('Unable to load WhatsApp conversations.', 500, [error]);

  const conversations = (data ?? []) as Array<Record<string, unknown>>;
  const ids = conversations.map((row) => String(row.id));

  if (ids.length) {
    const [{ data: inbound }, { data: agents }] = await Promise.all([
      supabase
        .from('ai_messages')
        .select('conversation_id, content, role, created_at')
        .in('conversation_id', ids)
        .order('created_at', { ascending: false }),
      supabase.from('admin_users').select('id, full_name')
    ]);

    const agentNames = new Map((agents ?? []).map((a) => [String(a.id), String(a.full_name ?? '')]));
    const latest = new Map<string, { content: string; role: string; created_at: string }>();
    const unread = new Map<string, number>();

    for (const message of inbound ?? []) {
      const key = String(message.conversation_id);
      if (!latest.has(key)) {
        latest.set(key, {
          content: String(message.content ?? ''),
          role: String(message.role),
          created_at: String(message.created_at)
        });
      }
      if (message.role !== 'user') continue;
      const conversation = conversations.find((row) => String(row.id) === key);
      const readAt = conversation?.agent_last_read_at ? new Date(String(conversation.agent_last_read_at)).getTime() : 0;
      if (new Date(String(message.created_at)).getTime() > readAt) {
        unread.set(key, (unread.get(key) ?? 0) + 1);
      }
    }

    for (const conversation of conversations) {
      const key = String(conversation.id);
      conversation.last_message = latest.get(key) ?? null;
      conversation.unread_count = unread.get(key) ?? 0;
      conversation.assigned_to_name = conversation.assigned_to ? agentNames.get(String(conversation.assigned_to)) ?? null : null;
    }
  }

  return sendSuccess(res, 'Conversations fetched successfully.', conversations);
});

/**
 * One thread with everything an agent needs to answer without asking the
 * traveller to repeat themselves: the messages, the delivery state of each,
 * the lead behind it and the structured travel context the assistant captured.
 */
export const getConversation = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const { data: conversation } = await supabase.from('ai_conversations').select('*').eq('id', id).maybeSingle();
  if (!conversation) throw new AppError('Conversation not found.', 404);

  const [{ data: messages }, { data: deliveries }, { data: notes }, { data: contact }] = await Promise.all([
    supabase.from('ai_messages').select('*').eq('conversation_id', id).order('created_at', { ascending: true }),
    // status carries the whole truth about transport, so wa_message_id is
    // deliberately not returned: a refused message holds a local stand-in id
    // that must never be read as evidence Meta accepted anything.
    supabase
      .from('whatsapp_messages')
      .select('ai_message_id, status, error_code, error_message, skipped_reason, direction')
      .eq('conversation_id', id),
    supabase.from('conversation_notes').select('*').eq('conversation_id', id).order('created_at', { ascending: false }),
    conversation.whatsapp_contact_id
      ? supabase.from('whatsapp_contacts').select('*').eq('id', conversation.whatsapp_contact_id).maybeSingle()
      : Promise.resolve({ data: null })
  ]);

  // The lead, so the panel shows the real enquiry rather than a guess.
  let lead: Record<string, unknown> | null = null;
  if (conversation.booking_request_id) {
    const { data } = await supabase
      .from('booking_requests')
      .select('id, booking_code, tour_id, full_name, email, phone, country, travel_date, number_of_adults, number_of_children, total_people, estimated_amount, currency, status, payment_status, special_requests, lead_context')
      .eq('id', conversation.booking_request_id)
      .maybeSingle();
    lead = data as Record<string, unknown> | null;
  }

  let tour: Record<string, unknown> | null = null;
  const tourId = (lead?.tour_id as string | undefined) ?? (conversation.preferred_tour_id as string | undefined);
  if (tourId) {
    const { data } = await supabase.from('tours').select('id, title, slug, duration_days, price_from, currency').eq('id', tourId).maybeSingle();
    tour = data as Record<string, unknown> | null;
  }

  // Quotations raised from this thread, so the agent can see what has already
  // been offered before quoting again — and pick up where the last one left off.
  const { data: quotations } = await supabase
    .from('quotations')
    .select('id, quote_code, title, currency, total_amount, status, valid_until, sent_at, viewed_at, accepted_at, created_at')
    .eq('conversation_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });

  const statusByMessage = new Map((deliveries ?? []).map((row) => [String(row.ai_message_id), row]));
  const withinWindow = canSendSessionMessage((contact as { last_inbound_at?: string } | null)?.last_inbound_at ?? null);

  return sendSuccess(res, 'Conversation fetched successfully.', {
    conversation,
    contact: contact ?? null,
    lead,
    tour,
    notes: notes ?? [],
    quotations: quotations ?? [],
    // Drives the composer: outside the window only a template may be sent.
    session_window_open: withinWindow,
    messages: (messages ?? []).map((message) => ({
      ...message,
      delivery: statusByMessage.get(String(message.id)) ?? null
    }))
  });
});

/** Mark the thread read up to now, clearing its unread badge. */
export const markConversationRead = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('ai_conversations')
    .update({ agent_last_read_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select('id, agent_last_read_at')
    .single();
  if (error) throw new AppError('Unable to mark the conversation read.', 500, [error]);
  return sendSuccess(res, 'Conversation marked read.', data);
});

/**
 * Assign, resolve, or hand control back to the assistant.
 *
 * Taking a thread as a human disables the AI on it. That is the §15 rule and
 * it is applied here rather than trusted to the caller, so no future code path
 * can assign an agent and leave the assistant still replying underneath them.
 */
export const updateConversationState = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { handoff_state: handoffState, assigned_to: assignedTo, ai_enabled: aiEnabled } = req.body as {
    handoff_state?: string;
    assigned_to?: string | null;
    ai_enabled?: boolean;
  };

  const STATES = ['AI_ACTIVE', 'HUMAN_REQUESTED', 'AGENT_ASSIGNED', 'HUMAN_ACTIVE', 'RESOLVED'];
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (handoffState !== undefined) {
    if (!STATES.includes(handoffState)) throw new AppError('Unknown handoff state.', 422);
    patch.handoff_state = handoffState;
    // A human owning the thread silences the assistant; returning it to
    // AI_ACTIVE is the only thing that switches it back on.
    if (['AGENT_ASSIGNED', 'HUMAN_ACTIVE'].includes(handoffState)) patch.ai_enabled = false;
    if (handoffState === 'AI_ACTIVE') patch.ai_enabled = true;
    if (handoffState === 'RESOLVED') patch.status = 'completed';
  }

  if (assignedTo !== undefined) {
    patch.assigned_to = assignedTo;
    if (assignedTo && handoffState === undefined) {
      patch.handoff_state = 'AGENT_ASSIGNED';
      patch.ai_enabled = false;
      patch.handoff_at = new Date().toISOString();
      patch.handoff_by = req.user?.sub ?? null;
    }
  }

  // An explicit ai_enabled in the request is the operator's final word.
  if (aiEnabled !== undefined) patch.ai_enabled = aiEnabled;

  const { data, error } = await supabase
    .from('ai_conversations')
    .update(patch)
    .eq('id', id)
    .select('id, handoff_state, assigned_to, ai_enabled, status')
    .single();
  if (error) throw new AppError('Unable to update the conversation.', 500, [error]);

  await safeAudit({ action: 'update', entityId: id, entityType: 'ai_conversations', newData: data, req });
  return sendSuccess(res, 'Conversation updated.', data);
});

/** Internal note — staff only, never delivered to the traveller. */
export const addConversationNote = asyncHandler(async (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) throw new AppError('A note body is required.', 422);

  const { data, error } = await supabase
    .from('conversation_notes')
    .insert({ conversation_id: req.params.id, author_id: req.user?.sub ?? null, body })
    .select('*')
    .single();
  if (error) throw new AppError('Unable to save the note.', 500, [error]);
  return sendSuccess(res, 'Note added.', data, 201);
});

/** Assignable agents for the inbox picker. */
export const listAgents = asyncHandler(async (_req, res) => {
  const { data, error } = await supabase
    .from('admin_users')
    .select('id, full_name, email')
    .order('full_name', { ascending: true });
  if (error) throw new AppError('Unable to load agents.', 500, [error]);
  return sendSuccess(res, 'Agents fetched successfully.', data ?? []);
});
