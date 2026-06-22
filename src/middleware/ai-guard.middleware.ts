import { createHash, createHmac, randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { countSessionMessagesToday } from '../services/ai-cost-control.service';
import { sendError } from '../utils/api-response';

// ----------------------------------------------------------------------------
// CGNAT-aware abuse protection (§6). The signed, HTTP-only session token is the
// real rate-limit key; IP is hashed and demoted to a weak anomaly signal only.
// Cloudflare Turnstile is the primary human check (enforced when configured).
// ----------------------------------------------------------------------------

const COOKIE = 'gf_ai_sid';

const sign = (sid: string) => createHmac('sha256', env.JWT_SECRET).update(sid).digest('hex').slice(0, 32);
const makeToken = (sid: string) => `${sid}.${sign(sid)}`;
const verifyToken = (token: string | undefined): string | null => {
  if (!token) return null;
  const [sid, sig] = token.split('.');
  if (!sid || !sig) return null;
  return sign(sid) === sig ? sid : null;
};

const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
};

const hashIp = (ip: string | undefined): string => createHash('sha256').update(`${ip ?? 'unknown'}:${env.JWT_SECRET}`).digest('hex').slice(0, 32);

const verifyTurnstile = async (token: string | undefined, ip: string | undefined): Promise<boolean> => {
  if (!env.TURNSTILE_SECRET_KEY) return false; // not configured → treated as unverified, but not blocked
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.append('secret', env.TURNSTILE_SECRET_KEY);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
    return Boolean(data?.success);
  } catch {
    return false;
  }
};

/**
 * Establish/verify the AI session token, hash the IP, and run the Turnstile
 * check. When Turnstile is configured it is REQUIRED (blocks on failure); when
 * it is not configured the request proceeds (dev / pre-rollout) so the existing
 * widget keeps working.
 */
export const aiChatGuard = (req: Request, res: Response, next: NextFunction): void => {
  void (async () => {
    // 1) Session token (the real rate-limit key).
    let sid = verifyToken(readCookie(req.headers.cookie, COOKIE));
    if (!sid) {
      sid = randomUUID();
      res.cookie(COOKIE, makeToken(sid), {
        httpOnly: true,
        sameSite: 'lax',
        secure: env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000,
        path: '/'
      });
    }
    req.aiSessionId = sid;
    req.aiIpHash = hashIp(req.ip);

    // 2) Turnstile (primary human check).
    const turnstileToken = (req.body as { turnstile_token?: string } | undefined)?.turnstile_token;
    req.aiTurnstileVerified = await verifyTurnstile(turnstileToken, req.ip);
    if (env.TURNSTILE_SECRET_KEY && !req.aiTurnstileVerified) {
      sendError(res, 'Please complete the verification challenge and try again.', [], 403);
      return;
    }

    // 3) Daily per-session cap (weak IP is handled by the limiter below).
    const sessionCount = await countSessionMessagesToday(sid);
    if (sessionCount >= env.AI_MAX_MESSAGES_PER_SESSION) {
      sendError(res, "You've reached today's chat limit for this device. You can continue with a Goldfinch specialist on WhatsApp.", [], 429);
      return;
    }

    next();
  })().catch(next);
};

/** Per-session burst limiter (20 / 10 min). Falls back to IP if no session yet. */
export const aiChatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.aiSessionId || req.ip || 'anonymous',
  handler: (_req, res) => {
    sendError(res, "You've sent several messages quickly. Please wait a moment or contact us on WhatsApp.", [], 429);
  }
});
