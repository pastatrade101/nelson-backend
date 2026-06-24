import { env } from '../config/env';
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
  travelDate: string;
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
  const tripTitle = str(lc.selected_trip) || str(tour?.title);

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
    travelDate: str(booking.travel_date),
    adults: Number(booking.number_of_adults ?? 0),
    children: Number(booking.number_of_children ?? 0),
    budgetRange: str(lc.budget_range) || str(lc.budget_per_person),
    tripDuration: str(lc.trip_duration),
    dateFlexibility: str(lc.date_flexibility),
    travelInterests: str(lc.travel_interests),
    accommodationPreference: str(lc.accommodation_preference),
    specialRequests: str(booking.special_requests),
    message: str(booking.message),
    sourcePageUrl: str(lc.source_page_url),
    leadSource: 'Website Booking Request',
    stage: 'New Lead',
    summary: ''
  };

  // Human-readable brief — handy for the email body, WhatsApp message and the
  // HubSpot note/message field (which accepts free text without custom props).
  const lines = [
    lead.tripTitle ? `Trip: ${lead.tripTitle}` : 'General trip request',
    lead.travelDate ? `Preferred date: ${lead.travelDate}${lead.dateFlexibility ? ` (flexibility: ${lead.dateFlexibility})` : ''}` : '',
    lead.tripDuration ? `Duration: ${lead.tripDuration}` : '',
    `Travellers: ${lead.adults} adults, ${lead.children} children`,
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

    // TODO(email): send an internal email to the specialist inbox with `lead`.
    //   e.g. await sendEmail({ to: env.SPECIALIST_EMAIL, subject: `New trip request — ${lead.tripTitle || lead.country}`, text: lead.summary });
    // TODO(whatsapp): notify the on-call specialist with a short brief.
    //   e.g. await sendWhatsApp({ to: env.SPECIALIST_WHATSAPP, text: `New lead ${lead.bookingCode}: ${lead.fullName}\n${lead.summary}` });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notification] Failed to send booking notification', error);
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
