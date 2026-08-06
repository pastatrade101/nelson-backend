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

// Email-safe hosted brand mark (300×300 gold elephant PNG). Change here if the
// primary domain/logo ever moves — must stay a public https PNG/JPG (email
// clients don't render AVIF/SVG or data-URI images reliably, esp. Gmail).
const LOGO_URL = 'https://emneladventures.com/emnel-icon.png';

const esc = (value: string): string =>
  (value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Clean 2-column details table; empty values are dropped, all values escaped. */
export const detailRows = (rows: Array<[string, string]>): string => {
  const body = rows
    .filter(([, value]) => value && value.trim())
    .map(
      ([label, value]) => `
        <tr>
          <td style="padding:9px 0;border-bottom:1px solid #eef1ee;color:#8a948f;font-size:13px;vertical-align:top;width:38%">${esc(label)}</td>
          <td style="padding:9px 0 9px 14px;border-bottom:1px solid #eef1ee;color:#1C1A16;font-size:14px;font-weight:600;vertical-align:top">${esc(value)}</td>
        </tr>`
    )
    .join('');
  return body
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:4px 0">${body}</table>`
    : '';
};

/** Highlighted free-text block (e.g. the customer's message); escaped, newlines kept. */
export const noteBlock = (label: string, text: string): string =>
  text && text.trim()
    ? `<div style="margin-top:18px">
         <div style="color:#8a948f;font-size:13px;margin-bottom:6px">${esc(label)}</div>
         <div style="background:#f7f5f0;border-left:3px solid #C5A265;border-radius:8px;padding:12px 14px;font-size:14px;color:#1C1A16;line-height:1.6">${esc(text).replace(/\n/g, '<br>')}</div>
       </div>`
    : '';

// An on-brand HTML shell (logo header + gold accent) so transactional emails look
// consistent. Body is composed with detailRows()/noteBlock() above.
export const emailLayout = (heading: string, bodyHtml: string, cta?: { label: string; url: string }): string => `
  <div style="margin:0;background:#f4f6f4;padding:24px;font-family:Inter,Arial,sans-serif;color:#18211f">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e6ebe7">
      <div style="background:#1C1A16;padding:26px 28px;text-align:center">
        <img src="${LOGO_URL}" width="52" height="52" alt="Emnel Adventures" style="display:block;margin:0 auto 10px;border:0" />
        <div style="color:#C5A265;font-weight:800;font-size:20px;letter-spacing:.5px;font-family:Georgia,'Times New Roman',serif">Emnel Adventures</div>
        <div style="color:#9a8f7a;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin-top:3px">Tanzania Safari Specialists</div>
      </div>
      <div style="height:3px;background:#C5A265"></div>
      <div style="padding:28px">
        <h1 style="margin:0 0 16px;font-size:19px;color:#1C1A16">${heading}</h1>
        <div style="font-size:15px;line-height:1.6;color:#384540">${bodyHtml}</div>
        ${
          cta
            ? `<a href="${cta.url}" style="display:inline-block;margin-top:22px;background:#1C1A16;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">${cta.label} →</a>`
            : ''
        }
      </div>
      <div style="padding:16px 28px;border-top:1px solid #e6ebe7;font-size:12px;color:#8a948f;text-align:center">
        Emnel Adventures · Tanzania safari specialists · Arusha, Tanzania
      </div>
    </div>
  </div>`;
