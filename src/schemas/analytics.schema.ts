import { z } from 'zod';

// Allowlisted event names — anything else is rejected at the edge so the table
// can never be polluted with arbitrary/abusive event names.
// MUST stay in step with the AnalyticsEventName union in
// frontend/src/lib/analytics.ts. Eleven names the frontend already emits —
// cta_click among them, from six call sites — were missing here and were being
// rejected 422 at the edge, so those events have never been recorded.
export const ANALYTICS_EVENT_NAMES = [
  'page_view',
  'tour_page_view',
  'destination_page_view',
  'safari_style_view',
  'accommodation_view',
  'tour_list_view',
  'tour_card_click',
  'related_tour_click',
  'tour_filter_used',
  'search',
  'no_search_results',
  'plan_my_trip_opened',
  'plan_my_trip_submitted',
  'begin_journey_opened',
  'begin_journey_submitted',
  'request_trip_opened',
  'request_trip_submitted',
  'quotation_download',
  'form_submit_error',
  // The contextual enquiry forms.
  'form_opened',
  'form_started',
  'form_step_completed',
  'form_validation_error',
  'form_abandoned',
  'form_submitted',
  'ai_advisor_opened',
  'ai_advisor_message_sent',
  'ai_advisor_lead_created',
  'cta_click',
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
  // The rest of the frontend's SAFE_KEYS. Without these declared, zod strips
  // them silently — the event lands with its context missing and nothing warns.
  // Every one of these is non-personal by construction.
  tour_name: shortStr(256),
  safari_style: shortStr(128),
  accommodation_level: shortStr(64),
  duration_days: z.coerce.number().int().nonnegative().optional().nullable(),
  price_from: z.coerce.number().nonnegative().optional().nullable(),
  currency: shortStr(8),
  list_name: shortStr(128),
  item_position: z.coerce.number().int().optional().nullable(),
  cta_name: shortStr(128),
  cta_type: shortStr(64),
  cta_location: shortStr(128),
  page_section: shortStr(128),
  search_term: shortStr(256),
  results_count: z.coerce.number().int().optional().nullable(),
  sort_option: shortStr(64),
  filter_name: shortStr(128),
  lead_type: shortStr(64),
  transaction_id: shortStr(128),
  form_name: shortStr(128),
  method: shortStr(64),
  error_type: shortStr(128),
  error_code: shortStr(64),
  // Enquiry-form context.
  form_type: shortStr(64),
  step_index: z.coerce.number().int().optional().nullable(),
  step_key: shortStr(64),
  field_name: shortStr(128),
  category_id: uuidOrEmpty,
  category_name: shortStr(128),
  tour_slug: shortStr(256),
  metadata: z.record(z.unknown()).optional().nullable()
});

export type TrackEventInput = z.infer<typeof trackEventSchema>;
