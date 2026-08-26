import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Authenticated encryption for credentials the platform stores on a business's
 * behalf — currently their WhatsApp access token.
 *
 * AES-256-GCM rather than CBC so the ciphertext carries its own authentication
 * tag: a tampered row fails to decrypt instead of yielding altered plaintext.
 * The key lives only in the server environment, so a database dump on its own
 * is not a working credential.
 *
 * Everything here fails loudly. There is no path that stores a secret in the
 * clear because a key was missing — that is the failure mode this exists to
 * prevent, and it would be invisible until the day it mattered.
 */

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';

/** 32 bytes, hex-encoded. Generate with: openssl rand -hex 32 */
const key = (): Buffer => {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'CREDENTIALS_ENCRYPTION_KEY is missing or malformed. It must be 32 bytes hex (openssl rand -hex 32).'
    );
  }
  return Buffer.from(raw, 'hex');
};

/** Whether credentials can be stored at all, for a readable check up front. */
export const canStoreSecrets = (): boolean => {
  try {
    key();
    return true;
  } catch {
    return false;
  }
};

/** `v1:iv:tag:ciphertext`, all hex. The version prefix leaves room to rotate. */
export const seal = (plaintext: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(':');
};

export const open = (sealed: string): string => {
  const [version, ivHex, tagHex, dataHex] = String(sealed).split(':');
  if (version !== VERSION || !ivHex || !tagHex || !dataHex) {
    throw new Error('Stored credential is not in a format this build can read.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  // Throws if the tag does not verify, which is the point: a row that has been
  // edited in the database is refused rather than half-trusted.
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
};

/**
 * A safe thing to show a human. Never the value — enough to tell two
 * credentials apart when someone is checking which one is configured.
 */
export const fingerprint = (secret: string): string =>
  secret.length < 8 ? '••••' : `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
