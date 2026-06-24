import { z } from 'zod';

// Allowlisted event names — anything else is rejected at the edge so the table
// can never be polluted with arbitrary/abusive event names.
export const ANALYTICS_EVENT_NAMES = [
  'page_view',
  'tour_page_view',
  'destination_page_view',
  'tour_card_click',
  'tour_filter_used',
  'plan_my_trip_opened',
  'plan_my_trip_submitted',
  'request_trip_opened',
  'request_trip_submitted',
  'ai_advisor_opened',
  'ai_advisor_message_sent',
  'ai_advisor_lead_created',
  'whatsapp_click',
  'phone_click',
  'email_click'
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

const shortStr = (max: number) => z.string().max(max).optional().nullable();
const uuidOrEmpty = z.union([z.string().uuid(), z.literal('')]).optional().nullable();

// Only safe, non-personal fields are accepted. `metadata` is additionally
// PII-scrubbed server-side (see analytics.service) as a defence-in-depth net.
export const trackEventSchema = z.object({
  event_name: z.enum(ANALYTICS_EVENT_NAMES),
  session_id: shortStr(64),
  page_path: shortStr(512),
  source_page_url: shortStr(1024),
  tour_id: uuidOrEmpty,
  tour_title: shortStr(256),
  destination: shortStr(128),
  experience_type: shortStr(256),
  budget_range: shortStr(64),
  traveller_type: shortStr(64),
  device_type: z.enum(['mobile', 'tablet', 'desktop']).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable()
});

export type TrackEventInput = z.infer<typeof trackEventSchema>;
