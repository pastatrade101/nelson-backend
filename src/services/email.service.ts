import { env } from '../config/env';

// ----------------------------------------------------------------------------
// Provider-agnostic transactional email. Pick ONE by setting env:
//   • Resend  → RESEND_API_KEY (recommended; HTTP API, no SMTP, great delivery)
//   • SMTP    → SMTP_HOST (+ port/user/pass/secure) for a domain mailbox
// If neither is configured, sends are skipped (logged) so nothing breaks.
// sendEmail never throws — callers get a boolean and decide how to proceed.
// ----------------------------------------------------------------------------

export type Mail = { to: string; subject: string; html: string; text?: string; replyTo?: string };

export const isEmailConfigured = (): boolean => Boolean(env.RESEND_API_KEY || env.SMTP_HOST);

const sendViaResend = async (mail: Mail): Promise<void> => {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      reply_to: mail.replyTo
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
  }
};

const sendViaSmtp = async (mail: Mail): Promise<void> => {
  const nodemailer = (await import('nodemailer')).default;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined
  });
  await transport.sendMail({
    from: env.EMAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    replyTo: mail.replyTo
  });
};

export const sendEmail = async (mail: Mail): Promise<boolean> => {
  try {
    if (env.RESEND_API_KEY) {
      await sendViaResend(mail);
      return true;
    }
    if (env.SMTP_HOST) {
      await sendViaSmtp(mail);
      return true;
    }
    console.warn(`[email] not configured — skipped: "${mail.subject}" -> ${mail.to}`);
    return false;
  } catch (err) {
    console.error('[email] send failed:', err instanceof Error ? err.message : err);
    return false;
  }
};

// A minimal, on-brand HTML shell so transactional emails look consistent.
export const emailLayout = (heading: string, bodyHtml: string, cta?: { label: string; url: string }): string => `
  <div style="margin:0;background:#f4f6f4;padding:24px;font-family:Inter,Arial,sans-serif;color:#18211f">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6ebe7">
      <div style="background:#0f2f24;padding:20px 28px">
        <span style="color:#d9a441;font-weight:800;font-size:18px;letter-spacing:.3px">Goldfinch Adventures</span>
      </div>
      <div style="padding:28px">
        <h1 style="margin:0 0 12px;font-size:20px;color:#0f2f24">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#384540">${bodyHtml}</div>
        ${
          cta
            ? `<a href="${cta.url}" style="display:inline-block;margin-top:20px;background:#0f2f24;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">${cta.label}</a>`
            : ''
        }
      </div>
      <div style="padding:16px 28px;border-top:1px solid #e6ebe7;font-size:12px;color:#8a948f">
        Goldfinch Adventures · East Africa travel specialists
      </div>
    </div>
  </div>`;
