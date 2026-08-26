import type { Request, Response } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { AppError, sendSuccess } from '../utils/api-response';
import { canStoreSecrets } from '../utils/secret-box';
import { safeAudit } from '../services/audit.service';
import {
  exchangeSignupCode,
  fetchPhoneNumberProfile,
  subscribeAppToWaba,
  whatsappConfig
} from '../services/whatsapp-client.service';
import {
  disconnectWhatsAppAccount,
  envAccountCredentials,
  liveWhatsAppAccount,
  recordVerification,
  resolveWhatsAppCredentials,
  storeConnectedAccount,
  toPublicAccount
} from '../services/whatsapp-credentials.service';

/**
 * Connecting a business's own WhatsApp Business account.
 *
 * Two ways in, one set of checks. Meta's Embedded Signup hands the browser a
 * one-time code, which only this server may exchange; the manual route exists
 * because Embedded Signup needs Tech Provider status and App Review, which are
 * not granted yet, and without it the feature would ship unusable. Both paths
 * verify the credentials against Meta and subscribe for webhooks before a
 * single byte is stored.
 *
 * The access token is never returned by any endpoint here, never logged and
 * never placed in an error message. Nothing below puts it in a response shape,
 * not even fingerprinted — a fingerprint is for a server-side comparison, not
 * for a browser.
 */

/** Meta object ids are long numeric strings; anything else is not one. */
const META_ID = /^\d{5,25}$/;

const requireMetaId = (value: unknown, label: string): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!META_ID.test(id)) throw new AppError(`A valid ${label} is required.`, 422);
  return id;
};

/**
 * What an admin needs to see, and nothing an admin must not.
 *
 * Reads the row and the resolved credentials together so the page can tell the
 * difference between "connected and working", "connected but broken" and
 * "still sending from this deployment's own environment credentials" — three
 * states that look identical if you only report a boolean.
 */
const connectionSummary = async () => {
  const [account, credentials] = await Promise.all([liveWhatsAppAccount(), resolveWhatsAppCredentials()]);
  const config = whatsappConfig();
  const environment = envAccountCredentials();

  return {
    connected: Boolean(account && account.status === 'connected' && !credentials.unavailableReason),
    source: credentials.source,
    using_env_fallback: credentials.source === 'environment',
    unavailable_reason: credentials.unavailableReason,
    // Named so the admin can be told exactly which variable to set rather than
    // being shown a failure after they have gone through Meta's whole flow.
    can_store_secrets: canStoreSecrets(),
    webhook_ready: Boolean(config.appSecret && config.verifyToken),
    graph_version: config.graphVersion,
    // The app id and the configuration id are public by design — the browser
    // SDK needs both. The App Secret is not here and never will be.
    embedded_signup: {
      ready: Boolean(config.appId && config.embeddedSignupConfigId),
      app_id: config.appId || null,
      config_id: config.embeddedSignupConfigId || null
    },
    account: account ? toPublicAccount(account) : null,
    environment: {
      has_phone_number_id: Boolean(environment.phoneNumberId),
      has_access_token: Boolean(environment.accessToken),
      has_business_account_id: Boolean(environment.businessAccountId)
    }
  };
};

export const getConnection = asyncHandler(async (_req, res) => {
  return sendSuccess(res, 'WhatsApp connection.', await connectionSummary());
});

/**
 * The half both routes share: verify, subscribe, then store.
 *
 * Order is the point. Nothing is written until Meta has confirmed the token
 * reads the number it claims, and webhooks are subscribed before the account
 * goes live so there is no window in which it sends but cannot receive.
 */
const finishConnection = async (input: {
  req: Request;
  res: Response;
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  tokenSource: 'embedded_signup' | 'manual';
}) => {
  const { req, res, wabaId, phoneNumberId, accessToken, tokenSource } = input;

  const profile = await fetchPhoneNumberProfile(phoneNumberId, accessToken);
  await subscribeAppToWaba(wabaId, accessToken);

  const account = await storeConnectedAccount({
    wabaId,
    phoneNumberId,
    accessToken,
    displayPhoneNumber: profile.displayPhoneNumber,
    verifiedName: profile.verifiedName,
    tokenSource,
    connectedBy: req.user?.sub ?? null
  });

  await safeAudit({
    action: 'update',
    entityId: account.id,
    entityType: 'whatsapp_accounts',
    // Identifiers only. The token is not in this object and must never be.
    newData: {
      waba_id: account.waba_id,
      phone_number_id: account.phone_number_id,
      display_phone_number: account.display_phone_number,
      verified_name: account.verified_name,
      token_source: account.token_source
    },
    req
  });

  return sendSuccess(
    res,
    `Connected ${profile.displayPhoneNumber ?? 'the WhatsApp Business number'}.`,
    await connectionSummary(),
    201
  );
};

/**
 * Meta Embedded Signup. The browser sends the one-time code and the two ids it
 * was handed, and nothing else — it never sees or handles an access token.
 */
export const connectAccount = asyncHandler(async (req, res) => {
  if (!canStoreSecrets()) {
    throw new AppError(
      'This server cannot store credentials: CREDENTIALS_ENCRYPTION_KEY is missing or malformed. Set it to 32 bytes of hex (openssl rand -hex 32) and restart before connecting an account.',
      503
    );
  }

  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  if (!code) throw new AppError('The authorisation code from Meta is required.', 422);

  const wabaId = requireMetaId(req.body?.waba_id, 'WhatsApp Business account id');
  const phoneNumberId = requireMetaId(req.body?.phone_number_id, 'phone number id');

  const accessToken = await exchangeSignupCode(code);
  return finishConnection({ req, res, wabaId, phoneNumberId, accessToken, tokenSource: 'embedded_signup' });
});

/**
 * Credentials typed in from WhatsApp Manager, for as long as Embedded Signup
 * is unavailable to us. Same verification and the same subscribe: a token
 * arriving by hand earns no less scrutiny than one Meta issued directly.
 */
export const connectAccountManually = asyncHandler(async (req, res) => {
  if (!canStoreSecrets()) {
    throw new AppError(
      'This server cannot store credentials: CREDENTIALS_ENCRYPTION_KEY is missing or malformed. Set it to 32 bytes of hex (openssl rand -hex 32) and restart before connecting an account.',
      503
    );
  }

  const wabaId = requireMetaId(req.body?.waba_id, 'WhatsApp Business account id');
  const phoneNumberId = requireMetaId(req.body?.phone_number_id, 'phone number id');

  const accessToken = typeof req.body?.access_token === 'string' ? req.body.access_token.trim() : '';
  // Length only. Whether it is the right token is Meta's call, not a regex's,
  // and asking Meta is the next thing that happens.
  if (accessToken.length < 20) throw new AppError('A WhatsApp access token is required.', 422);

  return finishConnection({ req, res, wabaId, phoneNumberId, accessToken, tokenSource: 'manual' });
});

/**
 * End the connection. The site falls back to its environment credentials, if
 * it has any, on the very next send.
 *
 * The app is deliberately NOT unsubscribed from the WABA: the same business
 * account may serve another site, and silently breaking someone else's inbound
 * messages is a worse failure than leaving a subscription in place.
 */
export const disconnectAccount = asyncHandler(async (req, res) => {
  const account = await disconnectWhatsAppAccount('Disconnected from the admin.');
  if (!account) throw new AppError('There is no connected WhatsApp account to disconnect.', 404);

  await safeAudit({
    action: 'delete',
    entityId: account.id,
    entityType: 'whatsapp_accounts',
    oldData: { waba_id: account.waba_id, phone_number_id: account.phone_number_id },
    req
  });

  return sendSuccess(res, 'WhatsApp account disconnected.', await connectionSummary());
});

/**
 * Ask Meta whether the stored credentials still work, and write the answer to
 * the row.
 *
 * A token can be revoked, a number can be removed from a WABA, and neither
 * announces itself — the first sign is a traveller not getting a reply. This
 * turns that into something an admin can check, and a failed check leaves its
 * reason on the account rather than only in this response.
 *
 * Answers 200 either way: "we asked, and here is what came back" is the
 * result, and a working failure report is not an API error.
 */
export const testConnection = asyncHandler(async (_req, res) => {
  const credentials = await resolveWhatsAppCredentials();
  if (!credentials.phoneNumberId || !credentials.accessToken) {
    throw new AppError(credentials.unavailableReason ?? 'No WhatsApp credentials are configured.', 503);
  }

  const checkedAt = new Date().toISOString();

  try {
    const profile = await fetchPhoneNumberProfile(credentials.phoneNumberId, credentials.accessToken);

    if (credentials.accountId) {
      await recordVerification(credentials.accountId, {
        status: 'connected',
        statusDetail: null,
        displayPhoneNumber: profile.displayPhoneNumber,
        verifiedName: profile.verifiedName
      });
    }

    return sendSuccess(res, 'The WhatsApp connection is working.', {
      ok: true,
      source: credentials.source,
      checked_at: checkedAt,
      display_phone_number: profile.displayPhoneNumber,
      verified_name: profile.verifiedName,
      number_status: profile.numberStatus,
      connection: await connectionSummary()
    });
  } catch (error) {
    // Meta's own words. graphFailure has already reduced the response to its
    // message and code; the bearer token was never part of either.
    const reason = error instanceof AppError ? error.message : 'Could not reach WhatsApp.';

    if (credentials.accountId) {
      await recordVerification(credentials.accountId, { status: 'error', statusDetail: reason });
    }

    return sendSuccess(res, 'The WhatsApp connection is not working.', {
      ok: false,
      source: credentials.source,
      checked_at: checkedAt,
      reason,
      connection: await connectionSummary()
    });
  }
});
