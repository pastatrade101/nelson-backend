import { env } from '../config/env';
import { emailLayout, sendEmail } from './email.service';
import { syncToHubSpot } from './hubspot.service';

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

/** Escape user-supplied text before interpolating into notification HTML. */
const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Flattens a booking row (+ its lead_context) into a CRM-ready lead. */
export const buildLeadFromBooking = (booking: BookingLike): CrmLead => {
  const lc = (booking.lead_context as Record<string, unknown> | null) ?? {};
  const tour = (booking.tours as Record<string, unknown> | null) ?? null;

  const fullName = str(booking.full_name);
  const nameParts = fullName.split(/\s+/).filter(Boolean);
  const destinationInterest = str(lc.destination_interest);
  const tripTitle = str(lc.selected_trip) || str(tour?.title) || destinationInterest;

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
  lead.summary = lines.join('\n');

  return lead;
};

/**
 * Internal notification hook. No email/WhatsApp provider is wired yet, so in
 * development we log a clean brief. This NEVER throws — booking creation must
 * not be blocked by a notification failure.
 */
export const sendBookingNotification = async (booking: BookingLike): Promise<void> => {
  try {
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
      await sendEmail({
        to: env.SPECIALIST_EMAIL,
        replyTo: lead.email || undefined,
        subject: `New trip request — ${lead.tripTitle || lead.destinationInterest || lead.country || lead.fullName}`,
        html: emailLayout(
          `New trip request · ${lead.bookingCode || ''}`,
          `<p><strong>${lead.fullName || 'A traveller'}</strong> &lt;${lead.email || 'no email'}&gt;${lead.phone ? ` · ${lead.phone}` : ''}</p>
           <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#384540">${lead.summary}</pre>`
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
      await sendEmail({
        to: env.SPECIALIST_EMAIL,
        replyTo: email || undefined,
        subject: `New contact message — ${subject || fullName || email || 'Website enquiry'}`,
        html: emailLayout(
          'New contact message',
          `<p><strong>${escapeHtml(fullName) || 'A visitor'}</strong> &lt;${escapeHtml(email) || 'no email'}&gt;${phone ? ` · ${escapeHtml(phone)}` : ''}</p>
           ${subject ? `<p><strong>Subject:</strong> ${escapeHtml(subject)}</p>` : ''}
           <pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;color:#384540">${escapeHtml(body)}</pre>`
        ),
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
