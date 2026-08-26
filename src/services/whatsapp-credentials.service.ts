import { supabase } from '../config/supabase';
import { AppError } from '../utils/api-response';
import { canStoreSecrets, open, seal } from '../utils/secret-box';

/**
 * Which WhatsApp account this site sends from.
 *
 * The number used to be fixed in the container's environment, so it was always
 * whoever built the site. A business can now connect their own account and
 * their row wins — but the environment stays as the fallback, because this site
 * is sending live from it today and must not go quiet the moment this ships.
 *
 * Only ACCOUNT-level credentials live here: the WABA id, the phone number id
 * and the access token. App-level values (app id, App Secret, verify token,
 * Graph version) belong to the Meta app rather than to any one business, stay
 * in the environment, and are read synchronously by whatsappConfig() — the
 * webhook signature check runs on every delivery and must not wait on a
 * database read to decide whether a request is genuinely from Meta.
 */

export type CredentialSource = 'connected_account' | 'environment' | 'none';

export type ResolvedWhatsAppCredentials = {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
  source: CredentialSource;
  /** whatsapp_accounts.id when a connected account is in use, else null. */
  accountId: string | null;
  /** Why sending is unavailable, in words an admin can act on. */
  unavailableReason: string | null;
};

export type WhatsAppAccountRow = {
  id: string;
  waba_id: string;
  phone_number_id: string;
  display_phone_number: string | null;
  verified_name: string | null;
  access_token_encrypted: string;
  token_source: string;
  status: string;
  status_detail: string | null;
  connected_at: string;
  connected_by: string | null;
  last_verified_at: string | null;
};

/** Everything but the ciphertext — the shape that is safe to hand to a browser. */
export type PublicWhatsAppAccount = Omit<WhatsAppAccountRow, 'access_token_encrypted'>;

const ACCOUNT_COLUMNS =
  'id, waba_id, phone_number_id, display_phone_number, verified_name, access_token_encrypted, token_source, status, status_detail, connected_at, connected_by, last_verified_at';

export const toPublicAccount = ({ access_token_encrypted: _sealed, ...rest }: WhatsAppAccountRow): PublicWhatsAppAccount =>
  rest;

export type EnvAccountCredentials = {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
};

/** The pre-connection sender: whatever the deployment was given at build time. */
export const envAccountCredentials = (): EnvAccountCredentials => ({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
  businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? ''
});

/**
 * The account this site is bound to, working or not.
 *
 * 'error' rows count as live on purpose. A connection whose token Meta has
 * stopped accepting is still the account the business connected, and dropping
 * back to the environment would put the previous number back on the wire
 * without anyone asking for it — the one outcome this feature must never have.
 * Only a soft delete (a disconnect, or being replaced) ends a connection.
 */
export const liveWhatsAppAccount = async (): Promise<WhatsAppAccountRow | null> => {
  const { data, error } = await supabase
    .from('whatsapp_accounts')
    .select(ACCOUNT_COLUMNS)
    .is('deleted_at', null)
    .in('status', ['connected', 'error'])
    // A partial unique index already allows only one live 'connected' row;
    // ordering is belt and braces for the moment one is being replaced.
    .order('status', { ascending: true })
    .order('connected_at', { ascending: false })
    .limit(1);

  if (error) {
    // A connection that cannot be read is "no connection", not an outage. The
    // table may not exist yet — a deploy reaching a database whose migration has
    // not been applied is the normal order of things — and throwing here would
    // stop a site that has been sending perfectly well from the environment.
    console.error('[whatsapp] could not read the connected account; falling back to the environment', {
      code: (error as { code?: string }).code ?? 'unknown'
    });
    return null;
  }
  return ((data ?? [])[0] as WhatsAppAccountRow | undefined) ?? null;
};

/**
 * The same read, but for the admin screen, where "I could not tell" and "there
 * is no connection" are different answers and the difference is actionable.
 */
export const liveWhatsAppAccountOrThrow = async (): Promise<WhatsAppAccountRow | null> => {
  const { data, error } = await supabase
    .from('whatsapp_accounts')
    .select(ACCOUNT_COLUMNS)
    .is('deleted_at', null)
    .in('status', ['connected', 'error'])
    .order('status', { ascending: true })
    .order('connected_at', { ascending: false })
    .limit(1);

  if (error) throw new AppError('Unable to read the WhatsApp connection.', 503, [error]);
  return ((data ?? [])[0] as WhatsAppAccountRow | undefined) ?? null;
};

/**
 * Which credentials win, given a row and the environment.
 *
 * Pure and separate from the query so the precedence — the part that decides
 * whose number a traveller sees — can be tested without a database.
 */
export const chooseCredentials = (
  account: WhatsAppAccountRow | null,
  environment: EnvAccountCredentials,
  openSealed: (sealed: string) => string = open
): ResolvedWhatsAppCredentials => {
  if (account) {
    let accessToken: string;
    try {
      accessToken = openSealed(account.access_token_encrypted);
    } catch {
      // Deliberately NOT the environment fallback. A connected account whose
      // token cannot be read is a broken connection, and quietly sending from
      // the previous number instead would look like success to everyone.
      return {
        phoneNumberId: account.phone_number_id,
        accessToken: '',
        businessAccountId: account.waba_id,
        source: 'connected_account',
        accountId: account.id,
        unavailableReason:
          'The connected WhatsApp account is stored with a token this server cannot read. Check CREDENTIALS_ENCRYPTION_KEY, then reconnect the account.'
      };
    }

    return {
      phoneNumberId: account.phone_number_id,
      accessToken,
      businessAccountId: account.waba_id,
      source: 'connected_account',
      accountId: account.id,
      unavailableReason: null
    };
  }

  if (environment.phoneNumberId && environment.accessToken) {
    return { ...environment, source: 'environment', accountId: null, unavailableReason: null };
  }

  return {
    phoneNumberId: '',
    accessToken: '',
    businessAccountId: environment.businessAccountId,
    source: 'none',
    accountId: null,
    unavailableReason: 'No WhatsApp account is connected and no WhatsApp credentials are set in the environment.'
  };
};

/**
 * Short-lived module cache.
 *
 * Every outbound message resolves credentials, and one database read plus a
 * decrypt per send is waste. 60 seconds is the deliberate ceiling on how long
 * a stale answer can survive a change made somewhere this process cannot see —
 * connect and disconnect clear it here and now, so the only window is another
 * container's write.
 */
const CACHE_TTL_MS = 60_000;

let cache: { at: number; value: ResolvedWhatsAppCredentials } | null = null;
let inFlight: Promise<ResolvedWhatsAppCredentials> | null = null;

/** Called by connect and disconnect: a change must take effect on the next send. */
export const clearWhatsAppCredentialsCache = (): void => {
  cache = null;
  inFlight = null;
};

export const resolveWhatsAppCredentials = async (): Promise<ResolvedWhatsAppCredentials> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;
  if (inFlight) return inFlight;

  // A burst of sends on a cold cache shares one read rather than racing.
  const pending = (async () => {
    const account = await liveWhatsAppAccount();
    const value = chooseCredentials(account, envAccountCredentials());
    cache = { at: Date.now(), value };
    return value;
  })();

  inFlight = pending;
  try {
    return await pending;
  } finally {
    // A failed read is not cached, so the next send retries rather than
    // inheriting a minute of "not configured".
    if (inFlight === pending) inFlight = null;
  }
};

// ── Writes ──────────────────────────────────────────────────────────────────

const refuseWithoutKey = () => {
  if (!canStoreSecrets()) {
    throw new AppError(
      'This server cannot store credentials: CREDENTIALS_ENCRYPTION_KEY is missing or malformed. Set it to 32 bytes of hex (openssl rand -hex 32) and restart before connecting an account.',
      503
    );
  }
};

export type ConnectAccountInput = {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  tokenSource: 'embedded_signup' | 'manual';
  connectedBy: string | null;
};

/**
 * Store a verified connection, replacing whatever was live before.
 *
 * The previous row is retired first because a partial unique index allows only
 * one live account per site — a second connection replaces the first rather
 * than quietly competing with it, so there is never a question of which number
 * sent. Only ever reached after Meta has confirmed the token works.
 */
export const storeConnectedAccount = async (input: ConnectAccountInput): Promise<WhatsAppAccountRow> => {
  refuseWithoutKey();

  const now = new Date().toISOString();

  const { error: retireError } = await supabase
    .from('whatsapp_accounts')
    .update({
      status: 'disconnected',
      status_detail: 'Replaced by a newer connection.',
      deleted_at: now,
      updated_at: now
    })
    .is('deleted_at', null);
  if (retireError) throw new AppError('Unable to replace the existing WhatsApp connection.', 500, [retireError]);

  const { data, error } = await supabase
    .from('whatsapp_accounts')
    .insert({
      waba_id: input.wabaId,
      phone_number_id: input.phoneNumberId,
      display_phone_number: input.displayPhoneNumber,
      verified_name: input.verifiedName,
      access_token_encrypted: seal(input.accessToken),
      token_source: input.tokenSource,
      status: 'connected',
      connected_at: now,
      connected_by: input.connectedBy,
      last_verified_at: now
    })
    .select(ACCOUNT_COLUMNS)
    .single();

  if (error) {
    // The previous connection has already been retired at this point, so say
    // so: the site is on its environment fallback until this is retried.
    throw new AppError(
      'The WhatsApp account was verified but could not be saved. Any previous connection has been retired, so this site is using its environment credentials until you try again.',
      500,
      [error]
    );
  }

  clearWhatsAppCredentialsCache();
  return data as WhatsAppAccountRow;
};

/** Soft-delete the live connection. Returns null when there was nothing to end. */
export const disconnectWhatsAppAccount = async (reason: string): Promise<WhatsAppAccountRow | null> => {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from('whatsapp_accounts')
    .update({ status: 'disconnected', status_detail: reason, deleted_at: now, updated_at: now })
    .is('deleted_at', null)
    .select(ACCOUNT_COLUMNS);

  if (error) throw new AppError('Unable to disconnect the WhatsApp account.', 500, [error]);

  clearWhatsAppCredentialsCache();
  return ((data ?? [])[0] as WhatsAppAccountRow | undefined) ?? null;
};

export type VerificationResult = {
  status: 'connected' | 'error';
  statusDetail: string | null;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
};

/** Write back what a live check found, so the admin sees why it stopped working. */
export const recordVerification = async (
  accountId: string,
  result: VerificationResult
): Promise<WhatsAppAccountRow | null> => {
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: result.status,
    status_detail: result.statusDetail,
    last_verified_at: now,
    updated_at: now
  };
  // Meta is the authority on the display name and number; a failed check has
  // nothing new to say about either, so it leaves them as they were.
  if (result.displayPhoneNumber !== undefined) patch.display_phone_number = result.displayPhoneNumber;
  if (result.verifiedName !== undefined) patch.verified_name = result.verifiedName;

  const { data, error } = await supabase
    .from('whatsapp_accounts')
    .update(patch)
    .eq('id', accountId)
    .is('deleted_at', null)
    .select(ACCOUNT_COLUMNS)
    .maybeSingle();

  if (error) throw new AppError('Unable to record the WhatsApp connection check.', 500, [error]);

  clearWhatsAppCredentialsCache();
  return (data as WhatsAppAccountRow | null) ?? null;
};
