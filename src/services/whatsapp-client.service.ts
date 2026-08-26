import { AppError } from '../utils/api-response';
import { connectTransportEnabled, sendViaConnect } from './makutano-connect.service';
import { resolveWhatsAppCredentials } from './whatsapp-credentials.service';
import type { ResolvedWhatsAppCredentials } from './whatsapp-credentials.service';

/**
 * WhatsApp Business Cloud API transport.
 *
 * Credentials are read here only — nothing in this file is importable by the
 * frontend, and no token, App Secret or phone number id is ever returned to a
 * caller or written to a log.
 *
 * They arrive from two places, and the split matters. APP-level values below
 * belong to the Meta app, are shared by every business it serves and stay in
 * the environment. ACCOUNT-level values — the phone number id, the WABA id and
 * the token — belong to the business and come from
 * resolveWhatsAppCredentials(), which prefers a connected account and falls
 * back to the environment.
 */

export type WhatsAppAppConfig = {
  appId: string;
  appSecret: string;
  verifyToken: string;
  graphVersion: string;
  embeddedSignupConfigId: string;
};

/**
 * App-level configuration only, and deliberately still synchronous: the
 * webhook signature check runs on every delivery Meta makes and must not wait
 * on a database read to decide whether a request is genuine.
 */
export const whatsappConfig = (): WhatsAppAppConfig => ({
  appId: process.env.WHATSAPP_APP_ID ?? '',
  appSecret: process.env.WHATSAPP_APP_SECRET ?? '',
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ?? '',
  graphVersion: process.env.WHATSAPP_GRAPH_VERSION || 'v21.0',
  embeddedSignupConfigId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID ?? ''
});

const GRAPH_HOST = 'https://graph.facebook.com';

const graphBase = (): string => `${GRAPH_HOST}/${whatsappConfig().graphVersion}`;

/**
 * Whether sending is possible at all. Reads as a boolean, never as a secret.
 *
 * Async because the answer now depends on which account is connected. A
 * database read that fails answers "no" rather than throwing — this is a
 * predicate callers branch on, and the send path itself raises the real reason
 * if an attempt is actually made.
 */
export const whatsappSendingAvailable = async (): Promise<boolean> => {
  // Through Makutano Connect the account is resolved server-side there; the
  // only local question is whether the transport is configured.
  if (connectTransportEnabled()) return true;
  try {
    const credentials = await resolveWhatsAppCredentials();
    return Boolean(credentials.phoneNumberId && credentials.accessToken);
  } catch {
    return false;
  }
};

const requireSendableCredentials = async (): Promise<ResolvedWhatsAppCredentials> => {
  const credentials = await resolveWhatsAppCredentials();
  if (!credentials.phoneNumberId || !credentials.accessToken) {
    throw new AppError(credentials.unavailableReason ?? 'WhatsApp is not configured on this server.', 503);
  }
  return credentials;
};

/** Digits only, no plus — the shape Meta calls wa_id. */
export const toWaId = (phone: string): string => phone.replace(/[^0-9]/g, '');

export type SendResult = {
  waMessageId: string;
  raw: Record<string, unknown>;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POST to the Graph API with a bounded retry.
 *
 * 429 and 5xx are transient — Meta rate-limits per phone number and sheds load
 * — so they are retried with exponential backoff, honouring Retry-After when
 * Meta sends one. 4xx other than 429 means the request itself is wrong and
 * retrying would only repeat the mistake, so those fail immediately.
 */
const graphPost = async (path: string, body: unknown, accessToken: string): Promise<Record<string, unknown>> => {
  const base = graphBase();
  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify(body)
      });
    } catch (cause) {
      // Network-level failure: worth another try.
      lastError = new AppError('Could not reach WhatsApp.', 502);
      if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 250);
      continue;
    }

    if (response.ok) return (await response.json()) as Record<string, unknown>;

    const detail = (await response.json().catch(() => ({}))) as {
      error?: { message?: string; code?: number; error_subcode?: number };
    };
    // Meta's message is safe to surface; the request body (which may carry a
    // traveller's phone number) deliberately is not.
    const message = detail.error?.message ?? `WhatsApp request failed (${response.status}).`;

    if (!RETRYABLE_STATUS.has(response.status) || attempt === MAX_ATTEMPTS) {
      throw new AppError(message, response.status === 429 ? 429 : 502, [
        { code: detail.error?.code, subcode: detail.error?.error_subcode }
      ]);
    }

    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250);
    lastError = new AppError(message, 502);
  }

  throw lastError ?? new AppError('WhatsApp request failed.', 502);
};

/**
 * Meta answering 2xx is not the same as Meta taking the message.
 *
 * Without a wamid there is nothing for a status callback to ever match, so the
 * message could never move past 'accepted' however it actually ended up. That
 * is a failed send, and it is refused here rather than stored as one that went.
 */
const requireMessageId = (raw: Record<string, unknown>): string => {
  const messages = raw.messages as Array<{ id?: string }> | undefined;
  const id = messages?.[0]?.id;
  if (!id) throw new AppError('WhatsApp accepted the request but returned no message id.', 502);
  return id;
};

/**
 * The safe, storable half of a send failure.
 *
 * graphPost has already reduced Meta's response to its own error text and
 * numeric code; the bearer token and the request body — which carries the
 * traveller's number — never leave this file, so what comes back here can be
 * written to a row and shown to an agent as it stands.
 */
export const describeSendFailure = (error: unknown): { message: string; code: string | null } => {
  if (error instanceof AppError) {
    const detail = (error.errors[0] ?? {}) as { code?: number | string };
    return { message: error.message, code: detail.code == null ? null : String(detail.code) };
  }
  return { message: error instanceof Error ? error.message : 'WhatsApp send failed.', code: null };
};

/**
 * Free-form session message. Only valid inside the 24-hour customer-service
 * window; outside it Meta rejects the send and a template must be used. The
 * caller is expected to have checked the window — see canSendSessionMessage.
 */
export const sendTextMessage = async (to: string, body: string): Promise<SendResult> => {
  if (connectTransportEnabled()) {
    return sendViaConnect(toWaId(to), { type: 'text', text: body, previewUrl: true });
  }
  const credentials = await requireSendableCredentials();
  const raw = await graphPost(
    `${credentials.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId(to),
      type: 'text',
      text: { preview_url: true, body }
    },
    credentials.accessToken
  );
  return { waMessageId: requireMessageId(raw), raw };
};

/**
 * Approved template message — the only thing that may open a conversation or
 * reach a contact outside the service window.
 */
export const sendTemplateMessage = async (
  to: string,
  templateName: string,
  languageCode: string,
  bodyParameters: string[] = []
): Promise<SendResult> => {
  if (connectTransportEnabled()) {
    return sendViaConnect(toWaId(to), {
      type: 'template',
      templateName,
      language: languageCode,
      ...(bodyParameters.length
        ? { components: [{ type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) }] }
        : {})
    });
  }
  const credentials = await requireSendableCredentials();
  const components = bodyParameters.length
    ? [{ type: 'body', parameters: bodyParameters.map((text) => ({ type: 'text', text })) }]
    : undefined;

  const raw = await graphPost(
    `${credentials.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toWaId(to),
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {})
      }
    },
    credentials.accessToken
  );
  return { waMessageId: requireMessageId(raw), raw };
};

/** Mark an inbound message read, so the traveller sees the blue ticks. */
export const markMessageRead = async (waMessageId: string): Promise<void> => {
  const credentials = await requireSendableCredentials();
  await graphPost(
    `${credentials.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId
    },
    credentials.accessToken
  );
};

/** The 24-hour customer-service window, measured from the last inbound message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export const canSendSessionMessage = (lastInboundAt: string | null | undefined): boolean => {
  if (!lastInboundAt) return false;
  const last = new Date(lastInboundAt).getTime();
  return Number.isFinite(last) && Date.now() - last < SERVICE_WINDOW_MS;
};

// ── Onboarding a business's own account ─────────────────────────────────────

/**
 * These three calls run once, while a business is connecting, against a token
 * that is not stored yet — so they take one explicitly rather than resolving
 * the site's own credentials, and they do not retry. The code exchange in
 * particular is single-use: a second attempt with the same code cannot succeed,
 * it can only turn a clear refusal into a confusing one.
 */

type GraphErrorBody = {
  error?: { message?: string; error_user_msg?: string; code?: number; error_subcode?: number };
};

/**
 * Meta's own reason, surfaced unchanged.
 *
 * "The token does not have permission for this phone number" is something an
 * admin can act on; "connection failed" is not. Meta's error bodies never echo
 * the credential that was sent, so this is safe to return and safe to store.
 */
const graphFailure = async (response: Response): Promise<AppError> => {
  const detail = (await response.json().catch(() => ({}))) as GraphErrorBody;
  const message =
    detail.error?.error_user_msg ||
    detail.error?.message ||
    `WhatsApp rejected the request (${response.status}).`;
  return new AppError(message, response.status >= 500 ? 502 : 400, [
    { code: detail.error?.code, subcode: detail.error?.error_subcode }
  ]);
};

/**
 * Exchange the one-time Embedded Signup code for the business's long-lived
 * token. The request URL carries the App Secret and the code, so it is never
 * logged and never included in an error.
 */
export const exchangeSignupCode = async (code: string): Promise<string> => {
  const config = whatsappConfig();
  if (!config.appId || !config.appSecret) {
    throw new AppError(
      'This server has no Meta app credentials. Set WHATSAPP_APP_ID and WHATSAPP_APP_SECRET before connecting an account.',
      503
    );
  }

  const url = new URL(`${graphBase()}/oauth/access_token`);
  url.searchParams.set('client_id', config.appId);
  url.searchParams.set('client_secret', config.appSecret);
  url.searchParams.set('code', code);

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new AppError('Could not reach Meta to exchange the authorisation code.', 502);
  }

  if (!response.ok) throw await graphFailure(response);

  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  if (!body.access_token) throw new AppError('Meta accepted the code but returned no access token.', 502);
  return body.access_token;
};

export type PhoneNumberProfile = {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  numberStatus: string | null;
};

/**
 * Prove the token works AND that it covers the number being claimed.
 *
 * This is the gate before anything is stored. A token that cannot read the
 * phone number id it arrived with is either the wrong token or somebody else's
 * account, and storing it would replace a working sender with one that fails
 * silently the next time a traveller writes in.
 */
export const fetchPhoneNumberProfile = async (
  phoneNumberId: string,
  accessToken: string
): Promise<PhoneNumberProfile> => {
  const url = new URL(`${graphBase()}/${encodeURIComponent(phoneNumberId)}`);
  url.searchParams.set('fields', 'display_phone_number,verified_name,status');

  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new AppError('Could not reach WhatsApp to check the phone number.', 502);
  }

  if (!response.ok) throw await graphFailure(response);

  const body = (await response.json().catch(() => ({}))) as {
    display_phone_number?: string;
    verified_name?: string;
    status?: string;
  };
  return {
    displayPhoneNumber: body.display_phone_number ?? null,
    verifiedName: body.verified_name ?? null,
    numberStatus: body.status ?? null
  };
};

/**
 * Point the WABA's webhooks at this app. Without it a connection sends fine
 * but nothing ever comes back, which looks like the travellers went quiet.
 */
export const subscribeAppToWaba = async (wabaId: string, accessToken: string): Promise<void> => {
  let response: Response;
  try {
    response = await fetch(`${graphBase()}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}` }
    });
  } catch {
    throw new AppError('Could not reach WhatsApp to subscribe this app for webhooks.', 502);
  }

  if (!response.ok) throw await graphFailure(response);

  const body = (await response.json().catch(() => ({}))) as { success?: boolean };
  if (body.success === false) {
    throw new AppError('Meta did not subscribe this app to the WhatsApp Business account.', 502);
  }
};
