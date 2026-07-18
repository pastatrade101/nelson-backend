/**
 * Send a one-off test email to verify your provider is configured.
 * The API key / SMTP creds are read from .env (never hardcoded).
 *
 *   npm run email:test you@example.com          (dev / tsx)
 *   npm run email:test:prod you@example.com     (built / node dist)
 *
 * Note: with the default sender onboarding@resend.dev, Resend only delivers to
 * YOUR Resend account email until you verify your own domain.
 */
import { env } from '../config/env';
import { isEmailConfigured, sendEmail, emailLayout } from '../services/email.service';

const run = async () => {
  const to = process.argv[2] || env.SPECIALIST_EMAIL;
  if (!to) {
    console.error('Usage: npm run email:test <recipient@example.com>');
    process.exit(1);
  }
  if (!isEmailConfigured()) {
    console.error('No email provider configured. Set RESEND_API_KEY (or SMTP_HOST + creds) in .env first.');
    process.exit(1);
  }

  const provider = env.RESEND_API_KEY ? 'Resend' : 'SMTP';
  console.log(`Sending a test email to ${to} via ${provider} (from: ${env.EMAIL_FROM})…`);

  const ok = await sendEmail({
    to,
    subject: 'Emnel email test ✅',
    html: emailLayout('Email is working', '<p>Your Emnel transactional email is configured correctly.</p>'),
    text: 'Your Emnel transactional email is configured correctly.'
  });

  console.log(ok ? '✓ Sent. Check the inbox (and spam folder).' : '✗ Failed — see the error logged above.');
  process.exit(ok ? 0 : 1);
};

run();
