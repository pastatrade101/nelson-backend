import { env } from '../config/env';
import { syncToHubSpot } from './hubspot.service';

type BookingLike = Record<string, unknown>;

/**
 * Placeholder booking notification hook. No email provider is wired yet, so in
 * development we log to the console. This NEVER throws — booking creation must
 * not be blocked by notification failures.
 */
export const sendBookingNotification = async (booking: BookingLike): Promise<void> => {
  try {
    if (env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.info(
        `[notification] New booking ${booking.booking_code ?? '(no code)'} ` +
          `from ${booking.full_name ?? 'unknown'} <${booking.email ?? 'no-email'}>` +
          `${booking.tour_id ? ` for tour ${booking.tour_id}` : ' (general trip request)'}`
      );
    }
    // Future: integrate a transactional email provider (Resend, Postmark, SES…) here.
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
    const leadContext = (booking.lead_context as Record<string, unknown> | null) ?? {};
    await syncToHubSpot('booking', {
      booking_code: booking.booking_code,
      full_name: booking.full_name,
      email: booking.email,
      phone: booking.phone,
      destination: leadContext.destination_interest,
      budget_tier: leadContext.budget_per_person,
      message: booking.message,
      stage: 'New Booking Request'
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[hubspot] Booking sync skipped due to error', error);
  }
};
