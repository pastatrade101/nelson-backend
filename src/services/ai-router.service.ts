// ----------------------------------------------------------------------------
// Rule-based router (§5.1). Runs BEFORE any Anthropic call. Many routes never
// touch the model — they are answered from CMS/settings (or the semantic cache,
// added in Phase 2). This is the cheapest cost lever after prompt caching.
// ----------------------------------------------------------------------------

export type RouteType =
  | 'cms_faq_no_ai'
  | 'cms_contact_no_ai'
  | 'cms_search_no_ai'
  | 'semantic_cache_hit_no_ai'
  | 'ai_simple'
  | 'ai_trip_match'
  | 'ai_booking_request'
  | 'blocked_rate_limit'
  | 'blocked_budget_limit'
  | 'degraded_haiku_only'
  | 'fallback_whatsapp';

export type RouteModel = 'simple' | 'reasoning';

export type RouteDecision = {
  route: RouteType;
  needsAi: boolean;
  model?: RouteModel;
  reason: string;
};

const has = (text: string, words: string[]) => words.some((w) => text.includes(w));

const CONTACT = ['contact', 'phone number', 'email address', 'whatsapp number', 'opening hour', 'office hour', 'what time are you open', 'where are you located', 'your address'];
const BOOKING_PROCESS_FAQ = ['how do i book', 'how to book', 'booking process', 'how does booking work', 'how do i pay', 'payment method', 'cancellation policy', 'refund policy', 'deposit'];
const LIST_INTENT = ['list destinations', 'show destinations', 'what destinations', 'show me tours', 'list tours', 'available tours', 'show available departures', 'what tours do you', 'see all tours'];
const BOOKING_INTENT = ['book this', 'book it', 'create a booking', 'make a booking', 'i want to book', 'reserve this', 'reserve a', 'send my request', 'create my request', 'submit my details'];
const TRIP_MATCH = ['which safari', 'recommend', 'suggest', 'help me choose', 'best fit', 'fits my', 'suit my', 'itinerary', 'plan a', 'plan my', 'budget', 'days', 'nights', ' vs ', 'compare', 'family', 'honeymoon', 'realistic', 'how many days', 'what can i do in'];

/**
 * Classify a visitor message into a route. Pure + deterministic — no I/O.
 * Order matters: most specific (booking) first, cheapest CMS routes next,
 * then the AI tiers.
 */
export const classifyMessage = (rawMessage: string): RouteDecision => {
  const message = (rawMessage ?? '').toLowerCase().trim();

  if (!message) {
    return { route: 'ai_simple', needsAi: true, model: 'simple', reason: 'Empty message — greet and prompt.' };
  }

  if (has(message, BOOKING_INTENT)) {
    return { route: 'ai_booking_request', needsAi: true, model: 'reasoning', reason: 'Explicit booking-request intent.' };
  }

  // No-AI CMS routes — answered deterministically from CMS/settings.
  if (has(message, CONTACT)) {
    return { route: 'cms_contact_no_ai', needsAi: false, reason: 'Contact / hours / location — from settings.' };
  }
  if (has(message, BOOKING_PROCESS_FAQ)) {
    return { route: 'cms_faq_no_ai', needsAi: false, reason: 'Booking-process / policy FAQ — from CMS.' };
  }
  if (has(message, LIST_INTENT)) {
    return { route: 'cms_search_no_ai', needsAi: false, reason: 'List destinations/tours — from CMS.' };
  }

  // AI routes.
  if (has(message, TRIP_MATCH)) {
    return { route: 'ai_trip_match', needsAi: true, model: 'reasoning', reason: 'Trip matching / suitability reasoning.' };
  }

  return { route: 'ai_simple', needsAi: true, model: 'simple', reason: 'General assistant chat.' };
};
