import { leadContextLines } from '../utils/lead-context';
import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { detailRows, emailLayout, escapeHtml, noteBlock, sendEmail } from './email.service';
import { syncToHubSpot } from './hubspot.service';
import { normalizeTier, TIER_LABELS } from '../utils/tiers';

// Public CMS base — used for the "Open in CMS" button in notification emails.
const ADMIN_URL = 'https://emneladventures.com/admin';

type BookingLike = Record<string, unknown>;

/**
 * Normalised, CRM-ready view of a booking request. This is the single shape we
 * hand to every downstream integration (HubSpot contact/deal, email, WhatsApp)
 * so each one reads tidy fields instead of digging through the raw row +
 * `lead_context` blob. Add a new channel by consuming a `CrmLead`.
 */
export type CrmLead = {
  bookingCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  country: string;
  tripId: string | null;
  tripTitle: string;
  destinationInterest: string;
  travelDate: string;
  travelMonth: string;
  travellerType: string;
  adults: number;
  children: number;
  budgetRange: string;
  tripDuration: string;
  dateFlexibility: string;
  travelInterests: string;
  accommodationPreference: string;
  specialRequests: string;
  message: string;
  sourcePageUrl: string;
  leadSource: string;
  stage: string;
  summary: string;
};

const str = (value: unknown): string => (value == null ? '' : String(value)).trim();

/** Flattens a booking row (+ its lead_context) into a CRM-ready lead. */
export const buildLeadFromBooking = (booking: BookingLike): CrmLead => {
  const lc = (booking.lead_context as Record<string, unknown> | null) ?? {};
  const tour = (booking.tours as Record<string, unknown> | null) ?? null;

  const fullName = str(booking.full_name);
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const destinationInterest = str(lc.destination_interest);
  const tripTitle = str(lc.selected_trip) || str(lc.tour_interest) || str(tour?.title) || destinationInterest;

  // Exact dates (Plan My Trip) read back into a friendly travel-date string.
  const exactStart = str(lc.exact_start_date);
  const exactEnd = str(lc.exact_end_date);
  const travelDate = str(booking.travel_date) || exactStart;

  const lead: CrmLead = {
    bookingCode: str(booking.booking_code),
    firstName: nameParts[0] ?? '',
    lastName: nameParts.slice(1).join(' '),
    fullName,
    email: str(booking.email),
    phone: str(booking.phone),
    country: str(booking.country),
    tripId: (booking.tour_id as string | null) ?? null,
    tripTitle,
    destinationInterest,
    travelDate,
    travelMonth: str(lc.travel_month),
    travellerType: str(lc.traveller_type),
    adults: Number(booking.number_of_adults ?? 0),
    children: Number(booking.number_of_children ?? 0),
    budgetRange: str(lc.budget_range) || str(lc.budget_per_person),
    tripDuration: str(lc.trip_duration),
    dateFlexibility: str(lc.date_flexibility),
    travelInterests: str(lc.travel_interests) || str(lc.experience_interests),
    accommodationPreference: str(lc.accommodation_preference),
    specialRequests: str(booking.special_requests),
    message: str(booking.message),
    sourcePageUrl: str(lc.source_page_url),
    leadSource: str(lc.lead_source) || 'Website Booking Request',
    stage: 'New Lead',
    summary: ''
  };

  // When/duration line prefers exact dates, then month, then a duration band.
  const whenLine = exactStart && exactEnd
    ? `Dates: ${exactStart} → ${exactEnd}`
    : lead.travelMonth
      ? `Travel month: ${lead.travelMonth}`
      : lead.travelDate
        ? `Preferred date: ${lead.travelDate}`
        : '';

  // Human-readable brief — handy for the email body, WhatsApp message and the
  // HubSpot note/message field (which accepts free text without custom props).
  const lines = [
    lead.tripTitle ? `Trip: ${lead.tripTitle}` : 'General trip request',
    whenLine ? `${whenLine}${lead.dateFlexibility ? ` (flexibility: ${lead.dateFlexibility})` : ''}` : '',
    lead.tripDuration ? `Duration: ${lead.tripDuration}` : '',
    `Travellers: ${lead.adults} adults, ${lead.children} children${lead.travellerType ? ` — ${lead.travellerType}` : ''}`,
    lead.budgetRange ? `Budget: ${lead.budgetRange}` : '',
    lead.accommodationPreference ? `Accommodation: ${lead.accommodationPreference}` : '',
    lead.travelInterests ? `Interests: ${lead.travelInterests}` : '',
    lead.specialRequests ? `Special requests: ${lead.specialRequests}` : '',
    lead.message ? `Notes: ${lead.message}` : ''
  ].filter(Boolean);
  lead.summary = [...lines, '', 'Complete saved brief:', ...leadContextLines(lc)].join('\n');

  return lead;
};

/**
 * Internal notification hook. No email/WhatsApp provider is wired yet, so in
 * development we log a clean brief. This NEVER throws — booking creation must
 * not be blocked by a notification failure.
 */
export const sendBookingNotification = async (booking: BookingLike): Promise<void> => {
  try {
    if (str(booking.source) === 'tour_enquiry') {
      await sendTourEnquiryNotification(booking);
      return;
    }
    const lead = buildLeadFromBooking(booking);

    if (env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.info(
        `[notification] New booking ${lead.bookingCode || '(no code)'} from ` +
          `${lead.fullName || 'unknown'} <${lead.email || 'no-email'}>\n${lead.summary}`
      );
    }

    // Email the specialist inbox (skips silently if email/recipient not configured).
    if (env.SPECIALIST_EMAIL) {
      const travellers =
        lead.adults + lead.children > 0
          ? `${lead.adults} adult${lead.adults === 1 ? '' : 's'}` +
            (lead.children ? `, ${lead.children} child${lead.children === 1 ? '' : 'ren'}` : '') +
            (lead.travellerType ? ` — ${lead.travellerType}` : '')
          : '';

      const bodyHtml =
        detailRows([
          ['Booking code', lead.bookingCode],
          ['Name', lead.fullName],
          ['Email', lead.email],
          ['Phone', lead.phone],
          ['Country', lead.country],
          ['Trip', lead.tripTitle],
          ['Travel date', lead.travelDate || lead.travelMonth],
          ['Duration', lead.tripDuration],
          ['Travellers', travellers],
          ['Budget', lead.budgetRange],
          ['Accommodation', lead.accommodationPreference],
          ['Interests', lead.travelInterests],
          ['Source', lead.leadSource]
        ]) + noteBlock('Special requests', lead.specialRequests) + noteBlock('Traveller notes', lead.message) + noteBlock('Complete trip brief', leadContextLines((booking.lead_context as Record<string, unknown>) ?? {}).join('\n'));

      await sendEmail({
        to: env.SPECIALIST_EMAIL,
        replyTo: lead.email || undefined,
        subject: `New trip request — ${lead.tripTitle || lead.destinationInterest || lead.country || lead.fullName}`,
        html: emailLayout(
          `New trip request${lead.bookingCode ? ` · ${lead.bookingCode}` : ''}`,
          bodyHtml,
          { label: 'Open in CMS', url: `${ADMIN_URL}/bookings` }
        ),
        text: `New booking ${lead.bookingCode}\n${lead.fullName} <${lead.email}>\n\n${lead.summary}`
      });
    }
    // TODO(whatsapp): notify the on-call specialist with a short brief.
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notification] Failed to send booking notification', error);
  }
};

/**
 * Alert the specialist inbox when a public contact-form message arrives. Mirrors
 * sendBookingNotification: fire-and-forget, never throws, and skips silently when
 * email transport or SPECIALIST_EMAIL is not configured.
 */
export const sendContactNotification = async (message: BookingLike): Promise<void> => {
  try {
    const fullName = str(message.full_name);
    const email = str(message.email);
    const phone = str(message.phone);
    const subject = str(message.subject);
    const body = str(message.message);

    if (env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.info(`[notification] New contact message from ${fullName || 'unknown'} <${email || 'no-email'}>`);
    }

    if (env.SPECIALIST_EMAIL) {
      const bodyHtml =
        detailRows([
          ['Name', fullName],
          ['Email', email],
          ['Phone', phone],
          ['Subject', subject]
        ]) + noteBlock('Message', body);

      await sendEmail({
        to: env.SPECIALIST_EMAIL,
        replyTo: email || undefined,
        subject: `New contact message — ${subject || fullName || email || 'Website enquiry'}`,
        html: emailLayout('New contact message', bodyHtml, { label: 'Open in CMS', url: `${ADMIN_URL}/messages` }),
        text: `New contact message\n${fullName} <${email}>${phone ? ` · ${phone}` : ''}\n${subject ? `Subject: ${subject}\n` : ''}\n${body}`
      });
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notification] Failed to send contact notification', error);
  }
};

/**
 * Best-effort HubSpot lead sync. Skips silently (and logs) when no token is
 * configured. Never throws — wrapped so booking creation is never blocked.
 */
export const syncBookingToHubSpot = async (booking: BookingLike): Promise<void> => {
  try {
    const lead = buildLeadFromBooking(booking);
    await syncToHubSpot('booking', {
      booking_code: lead.bookingCode,
      full_name: lead.fullName,
      email: lead.email,
      phone: lead.phone,
      country: lead.country,
      destination: lead.tripTitle,
      budget_tier: lead.budgetRange,
      message: lead.summary || lead.message,
      lead_source: lead.leadSource,
      stage: lead.stage,
      // Carry the full structured lead so the deal-creation step (and the sync
      // log) has everything it needs without re-deriving it.
      lead
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[hubspot] Booking sync skipped due to error', error);
  }
};

/**
 * Which inbox an enquiry belongs to: a per-source setting, then the default
 * setting, then the environment.
 */
export const recipientFor = async (source: string): Promise<string> => {
  const keys = [`enquiry_email_${source}`, 'enquiry_email_default'];

  try {
    const { data } = await supabase
      .from('website_settings')
      .select('setting_key,setting_value')
      .in('setting_key', keys);

    const map = new Map(
      (data ?? []).map((row: { setting_key: string; setting_value: unknown }) => [row.setting_key, row.setting_value])
    );
    for (const key of keys) {
      const value = String(map.get(key) ?? '').replace(/^"|"$/g, '').trim();
      if (value.includes('@')) return value;
    }
  } catch {
    // Settings unavailable — fall through to the env default.
  }

  return env.SPECIALIST_EMAIL || '';
};

// ── Tour-page request form (price grid + two-step form, 2026-11-18) ─────────

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const usd = (amount: number) => `US$${Math.round(amount).toLocaleString('en-US')}`;

/** What a tour-page request asked for, read off the saved row. */
export const tourEnquiryFacts = (booking: BookingLike) => {
  const lc = (booking.lead_context as Record<string, unknown> | null) ?? {};
  const tour = (booking.tours as Record<string, unknown> | null) ?? null;
  const tier = normalizeTier(str(lc.comfort_tier));
  const adults = Number(booking.number_of_adults ?? 0);
  const children = Number(booking.number_of_children ?? 0);
  const estimate = Number(booking.estimated_amount ?? 0);
  const travellers = plural(adults, 'adult', 'adults') + (children ? `, ${plural(children, 'child', 'children')}` : '');
  const tourTitle = str(tour?.title) || str(lc.tour_title) || 'Tour request';
  const tierLabel = tier ? TIER_LABELS[tier] : str(lc.comfort_label);
  const month = str(lc.travel_month_label) || 'Month not decided';
  return {
    code: str(booking.booking_code),
    tourTitle,
    tier: tierLabel,
    travellers,
    month,
    estimate: estimate > 0 ? `About ${usd(estimate)} in total` : 'Price on request',
    // The first line Nelson sees, e.g.
    // "10-Day Family Safari & Zanzibar · Classic · 2 adults, 2 children · July 2027".
    headline: [tourTitle, tierLabel, travellers, month].filter(Boolean).join(' · ')
  };
};

const entryPointLabel = (lc: Record<string, unknown>): string => {
  const entry = str(lc.entry_point);
  if (entry === 'price_cell') return `Price grid cell${str(lc.entry_cell) ? ` (${str(lc.entry_cell)})` : ''}`;
  if (entry === 'plan_button') return '“Plan this trip” under the price grid';
  return entry;
};

const campaignLine = (lc: Record<string, unknown>): string => {
  const a = (lc.attribution as Record<string, unknown> | null) ?? {};
  const parts = [
    str(a.utm_source) && `source ${str(a.utm_source)}`,
    str(a.utm_medium) && `medium ${str(a.utm_medium)}`,
    str(a.utm_campaign) && `campaign ${str(a.utm_campaign)}`,
    str(a.utm_term) && `term ${str(a.utm_term)}`,
    str(a.gclid) && 'Google Ads click',
    (str(a.gbraid) || str(a.wbraid)) && 'Google Ads click (app or iOS)',
    str(a.msclkid) && 'Microsoft Ads click',
    str(a.fbclid) && 'Facebook click'
  ].filter(Boolean);
  if (parts.length) return parts.join(', ');
  return str(a.referrer) ? `Referred by ${str(a.referrer)}` : 'Direct or unknown';
};

const sendTourEnquiryNotification = async (booking: BookingLike): Promise<void> => {
  const lc = (booking.lead_context as Record<string, unknown> | null) ?? {};
  const f = tourEnquiryFacts(booking);
  if (env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.info(`[notification] Tour request ${f.code}: ${f.headline}`);
  }
  const to = await recipientFor('tour_enquiry');
  if (!to) return;

  const a = (lc.attribution as Record<string, unknown> | null) ?? {};
  const bodyHtml =
    `<p style="margin:0 0 14px;font-size:16px;font-weight:700;color:#1C1A16">${escapeHtml(f.headline)}</p>` +
    detailRows([
      ['Reference', f.code],
      ['Name', str(booking.full_name)],
      ['Email', str(booking.email)],
      ['WhatsApp', str(booking.phone)],
      ['Comfort level', f.tier],
      ['Travellers', f.travellers],
      ['Travel month', f.month],
      ['Estimate shown', f.estimate],
      ['Asked from', entryPointLabel(lc)],
      ['Page', str(lc.source_page_url)],
      ['Campaign', campaignLine(lc)],
      ['Landing page', str(a.landing_page)]
    ]) +
    noteBlock('Dates, children’s ages or anything else', str(booking.message));

  const text = [
    f.headline,
    '',
    `Reference: ${f.code}`,
    `Name: ${str(booking.full_name)}`,
    `Email: ${str(booking.email)}`,
    str(booking.phone) && `WhatsApp: ${str(booking.phone)}`,
    `Estimate shown: ${f.estimate}`,
    `Asked from: ${entryPointLabel(lc)}`,
    `Campaign: ${campaignLine(lc)}`,
    str(booking.message) && `Notes: ${str(booking.message)}`
  ].filter(Boolean);

  await sendEmail({
    to,
    replyTo: str(booking.email) || undefined,
    subject: f.headline,
    html: emailLayout(
      `New safari request${f.code ? ` · ${escapeHtml(f.code)}` : ''}`,
      bodyHtml,
      { label: 'Open in CMS', url: `${ADMIN_URL}/bookings` }
    ),
    text: text.join('\n')
  });
  // TODO(whatsapp): send Nelson the same first line once a WhatsApp token and
  // an approved template are configured.
};

const whatsappNumber = async (): Promise<string> => {
  try {
    const { data } = await supabase.from('website_settings').select('setting_value').eq('setting_key', 'whatsapp_number').maybeSingle();
    return String((data as { setting_value?: unknown } | null)?.setting_value ?? '').replace(/^"|"$/g, '').trim();
  } catch {
    return '';
  }
};

/**
 * The guest's confirmation for a tour-page request: thanks, what they asked
 * for, their reference and the 24-hour promise. Never throws.
 */
export const sendEnquiryAutoReply = async (booking: BookingLike): Promise<void> => {
  try {
    const email = str(booking.email);
    if (!email) return;
    const f = tourEnquiryFacts(booking);
    const firstName = str(booking.full_name).split(/\s+/)[0] || 'there';
    const digits = (await whatsappNumber()).replace(/\D/g, '');
    const waUrl = digits
      ? `https://wa.me/${digits}?text=${encodeURIComponent(`Hello Nelson, my safari request reference is ${f.code}.`)}`
      : '';

    const bodyHtml =
      '<p style="margin:0 0 16px">Nelson will be in touch within 24 hours with your route and exact price. No payment is needed to ask.</p>' +
      detailRows([
        ['Reference', f.code],
        ['Safari', f.tourTitle],
        ['Comfort level', f.tier],
        ['Travellers', f.travellers],
        ['Travel month', f.month],
        ['Estimate', f.estimate]
      ]) +
      '<p style="margin:16px 0 0;font-size:13px;color:#6b746f">Prices are indicative until Nelson confirms your route. Reply to this email to add anything.</p>';

    const text = [
      `Thank you, ${firstName}.`,
      '',
      'Nelson will be in touch within 24 hours with your route and exact price. No payment is needed to ask.',
      '',
      `Reference: ${f.code}`,
      `Safari: ${f.tourTitle}`,
      f.tier && `Comfort level: ${f.tier}`,
      `Travellers: ${f.travellers}`,
      `Travel month: ${f.month}`,
      `Estimate: ${f.estimate}`,
      waUrl && `WhatsApp: ${waUrl}`
    ].filter(Boolean);

    await sendEmail({
      to: email,
      replyTo: (await recipientFor('tour_enquiry')) || undefined,
      subject: `Your safari request${f.code ? ` · ${f.code}` : ''}`,
      html: emailLayout(
        `Thank you, ${escapeHtml(firstName)}`,
        bodyHtml,
        waUrl ? { label: 'Message Nelson on WhatsApp', url: waUrl } : undefined
      ),
      text: text.join('\n')
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notification] Failed to send the guest confirmation', error);
  }
};
