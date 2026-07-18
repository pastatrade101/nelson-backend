import { supabase } from '../config/supabase';
import { semanticTourScores } from './ai-retrieval.service';

// ----------------------------------------------------------------------------
// Native tool implementations (§3.4, §9, §11, §13, §25). The model orchestrates
// these; it can never fabricate data because data only exists in tool results.
// Every call is audited to ai_tool_calls.
// ----------------------------------------------------------------------------

export type PageContext = {
  path?: string;
  tour_id?: string;
  tour_slug?: string;
  destination_id?: string;
  departure_id?: string;
};

export type AdvisorContext = {
  conversationId?: string;
  sessionId?: string;
  ipHash?: string;
  pageContext?: PageContext;
  /** Raw user query — used for the optional semantic tour boost (§9/§10). */
  queryText?: string;
};

export type Recommendation = {
  tour_id: string;
  title: string;
  slug: string;
  destination: string | null;
  duration_days: number | null;
  price_from: number | null;
  currency: string;
  availability_note: string;
  score: number; // internal 0–100
  confidence_label: string; // user-facing
  reasons: string[];
  limitations: string[];
  cta: string;
};

type ToolResult = { success: boolean; output: Record<string, unknown>; error?: string };

const norm = (v?: string | null) => (v ?? '').trim().toLowerCase();
const todayIso = () => new Date().toISOString().slice(0, 10);

export const confidenceLabel = (score: number): string => {
  if (score >= 85) return 'Excellent fit';
  if (score >= 70) return 'Strong fit';
  if (score >= 50) return 'Possible fit';
  return 'Weak fit';
};

// ── search_tours (§9) ────────────────────────────────────────────────────────
type ToursIntent = {
  destination?: string;
  experience?: string;
  persona_tags?: string[];
  duration_days?: number;
  budget_tier?: string;
  travelers?: number;
};

const MAX_RAW_SCORE = 155; // sum of all weights; used to normalize to 0–100

export const searchTours = async (intent: ToursIntent, ctx: AdvisorContext): Promise<Recommendation[]> => {
  const { data, error } = await supabase
    .from('tours')
    .select(
      'id,title,slug,short_description,persona_tags,duration_days,budget_tier,price_from,currency,is_featured,is_popular,seats_remaining,destinations(name,slug,country),tour_categories(name,slug)'
    )
    .eq('status', 'published')
    .eq('is_available', true)
    .is('deleted_at', null)
    .limit(24);

  if (error || !data?.length) return [];

  const tourIds = data.map((t) => (t as { id: string }).id);
  // One batched availability query for the candidate set.
  const availability = new Map<string, { hasDeparture: boolean; maxSlots: number }>();
  try {
    const { data: dates } = await supabase
      .from('available_dates')
      .select('tour_id,status,start_date,seats_available,available_slots')
      .in('tour_id', tourIds)
      .in('status', ['available', 'limited'])
      .gte('start_date', todayIso());
    for (const row of (dates ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.tour_id);
      const slots = Number(row.seats_available ?? row.available_slots ?? 0);
      const prev = availability.get(id) ?? { hasDeparture: false, maxSlots: 0 };
      availability.set(id, { hasDeparture: true, maxSlots: Math.max(prev.maxSlots, slots) });
    }
  } catch {
    // Availability is a bonus signal; absence just means lower scores.
  }

  const leadTags = (intent.persona_tags ?? []).map(norm).filter(Boolean);
  const wantDestination = norm(intent.destination);
  const wantExperience = norm(intent.experience);
  const travelers = intent.travelers ?? 1;

  // Optional semantic boost (§9/§10) — blends pgvector similarity with the
  // deterministic score. Empty map when embeddings are disabled (no-op).
  const semantic = ctx.queryText ? await semanticTourScores(ctx.queryText) : new Map<string, number>();

  const scored = data.map((row): Recommendation => {
    const tour = row as Record<string, unknown>;
    const dest = (Array.isArray(tour.destinations) ? tour.destinations[0] : tour.destinations) as
      | { name?: string; slug?: string; country?: string }
      | null;
    const cat = (Array.isArray(tour.tour_categories) ? tour.tour_categories[0] : tour.tour_categories) as
      | { name?: string; slug?: string }
      | null;
    const personaTags = (Array.isArray(tour.persona_tags) ? tour.persona_tags : []).map((t) => norm(String(t)));
    const avail = availability.get(String(tour.id)) ?? { hasDeparture: false, maxSlots: 0 };

    let raw = 0;
    const reasons: string[] = [];
    const limitations: string[] = [];

    // Experience / category match (30)
    if (wantExperience && (norm(cat?.slug) === wantExperience || norm(cat?.name).includes(wantExperience))) {
      raw += 30;
      if (cat?.name) reasons.push(`Matches your interest in ${cat.name}`);
    }
    // Destination match (25)
    if (wantDestination && (norm(dest?.name) === wantDestination || norm(dest?.country) === wantDestination || norm(dest?.slug) === wantDestination)) {
      raw += 25;
      if (dest?.name) reasons.push(`In ${dest.name}, where you want to go`);
    }
    // Persona / tags match (20)
    if (leadTags.length && leadTags.some((t) => personaTags.includes(t))) {
      raw += 20;
      reasons.push('Suits your travel style');
    }
    // Duration within preferred range ±2 (15)
    const durationDays = typeof tour.duration_days === 'number' ? tour.duration_days : null;
    if (intent.duration_days && durationDays != null && Math.abs(durationDays - intent.duration_days) <= 2) {
      raw += 15;
      reasons.push(`About ${durationDays} days, close to your plan`);
    }
    // Budget / comfort match (15)
    if (intent.budget_tier && norm(intent.budget_tier) === norm(String(tour.budget_tier ?? ''))) {
      raw += 15;
      reasons.push('Matches your comfort level');
    }
    // Available departure exists (20)
    if (avail.hasDeparture) raw += 20;
    // Enough slots for travelers (15)
    if (avail.hasDeparture && avail.maxSlots >= travelers) raw += 15;
    else if (avail.hasDeparture && avail.maxSlots > 0 && avail.maxSlots < travelers) {
      limitations.push(`Limited slots — may not fit ${travelers} travelers on every date`);
    }
    // Featured / recommended (5)
    if (tour.is_featured) raw += 5;
    // Page-context current-tour interest (10)
    if (ctx.pageContext?.tour_id && String(tour.id) === ctx.pageContext.tour_id) raw += 10;
    if (ctx.pageContext?.tour_slug && String(tour.slug) === ctx.pageContext.tour_slug) raw += 10;

    if (!avail.hasDeparture) limitations.push('No fixed departure yet — can be arranged as a tailor-made trip');

    let score = Math.min(100, Math.round((raw / MAX_RAW_SCORE) * 100));
    const sim = semantic.get(String(tour.id));
    if (sim != null) {
      score = Math.min(100, Math.round(score * 0.8 + sim * 100 * 0.2));
      if (sim >= 0.8 && reasons.length < 3) reasons.push('Closely matches what you described');
    }
    return {
      tour_id: String(tour.id),
      title: String(tour.title ?? ''),
      slug: String(tour.slug ?? ''),
      destination: dest?.name ?? null,
      duration_days: durationDays,
      price_from: typeof tour.price_from === 'number' ? tour.price_from : null,
      currency: String(tour.currency ?? 'USD'),
      availability_note: avail.hasDeparture ? 'Departures available — to be confirmed' : 'No fixed departure — custom trip possible',
      score,
      confidence_label: confidenceLabel(score),
      reasons: reasons.length ? reasons : ['A solid Emnel Tanzania option'],
      limitations,
      cta: `/tours/${String(tour.slug ?? '')}`
    };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 3);
};

// ── check_availability (§11) ─────────────────────────────────────────────────
const checkAvailability = async (input: Record<string, unknown>): Promise<ToolResult> => {
  const tourId = String(input.tour_id ?? '');
  const departureId = input.departure_id ? String(input.departure_id) : undefined;
  const travelers = Number(input.travelers ?? 1);
  if (!tourId) return { success: false, output: { available: false, message: 'A tour is required to check availability.' } };

  const { data: tour } = await supabase
    .from('tours')
    .select('id,status,is_available')
    .eq('id', tourId)
    .is('deleted_at', null)
    .maybeSingle();

  if (!tour || (tour as { status?: string }).status !== 'published' || (tour as { is_available?: boolean }).is_available === false) {
    return {
      success: true,
      output: { available: false, status: 'none', message: "I don't see this trip as currently bookable, but an Emnel specialist can arrange a tailor-made option." }
    };
  }

  const dateSelect = 'id,start_date,end_date,status,seats_available,available_slots,price';
  let rows: Array<Record<string, unknown>>;
  if (departureId) {
    const { data: dates } = await supabase.from('available_dates').select(dateSelect).eq('id', departureId);
    rows = (dates ?? []) as Array<Record<string, unknown>>;
  } else {
    const { data: dates } = await supabase
      .from('available_dates')
      .select(dateSelect)
      .eq('tour_id', tourId)
      .in('status', ['available', 'limited'])
      .gte('start_date', todayIso())
      .order('start_date', { ascending: true })
      .limit(6);
    rows = (dates ?? []) as Array<Record<string, unknown>>;
  }
  const fitting = rows.filter((r) => {
    const slots = Number(r.seats_available ?? r.available_slots ?? 0);
    return slots === 0 ? true : slots >= travelers;
  });

  if (!rows.length) {
    return {
      success: true,
      output: { available: false, status: 'none', departures: [], message: "I don't see a fixed departure for those dates, but Emnel can prepare a tailor-made option. Want me to send this as a custom request?" }
    };
  }
  if (!fitting.length) {
    return {
      success: true,
      output: { available: false, status: 'full', departures: rows, message: 'That departure appears full for your group size. I can suggest nearby dates or create a custom request.' }
    };
  }
  return {
    success: true,
    output: {
      available: true,
      status: 'available',
      departures: fitting,
      message: 'This looks available based on current system data, but an Emnel specialist will confirm.'
    }
  };
};

// ── extract_lead_context ─────────────────────────────────────────────────────
const extractLeadContext = async (input: Record<string, unknown>, ctx: AdvisorContext): Promise<ToolResult> => {
  const summary = typeof input.conversation_summary === 'string' ? input.conversation_summary : '';
  if (ctx.conversationId) {
    try {
      await supabase
        .from('ai_lead_context')
        .upsert({ conversation_id: ctx.conversationId, message_summary: summary }, { onConflict: 'conversation_id' });
      if (summary) await supabase.from('ai_conversations').update({ conversation_summary: summary }).eq('id', ctx.conversationId);
    } catch {
      // best effort
    }
  }
  const { data } = ctx.conversationId
    ? await supabase.from('ai_lead_context').select('*').eq('conversation_id', ctx.conversationId).maybeSingle()
    : { data: null };
  return { success: true, output: { lead_context: data ?? {}, message_summary: summary } };
};

// ── create_booking_request (§13) ─────────────────────────────────────────────
export const createBookingRequest = async (input: Record<string, unknown>, ctx: AdvisorContext): Promise<ToolResult> => {
  const idempotencyKey = String(input.idempotency_key ?? '');
  const conversationId = ctx.conversationId;
  if (!idempotencyKey) return { success: false, output: { error: 'idempotency_key is required.' } };
  if (!conversationId) return { success: false, output: { error: 'No conversation context.' } };

  // Idempotency: return the existing request if this key was already used.
  const { data: existing } = await supabase
    .from('booking_requests')
    .select('id,status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existing) {
    return { success: true, output: { booking_request_id: (existing as { id: string }).id, status: (existing as { status: string }).status, deduped: true } };
  }

  const { data: lead } = await supabase.from('ai_lead_context').select('*').eq('conversation_id', conversationId).maybeSingle();
  const ctxRow = (lead ?? {}) as Record<string, unknown>;

  const fullName = (ctxRow.full_name as string) || '';
  const email = (ctxRow.email as string) || '';
  const phone = (ctxRow.phone as string) || '';
  const adults = Number(ctxRow.adults ?? ctxRow.total_travelers ?? 1) || 1;
  const children = Number(ctxRow.children ?? 0) || 0;
  const experienceInterest = Array.isArray(ctxRow.experience_interest) ? (ctxRow.experience_interest as string[]) : [];

  const missing: string[] = [];
  if (!fullName) missing.push('name');
  if (!email && !phone) missing.push('email or phone');
  if (!experienceInterest.length && !ctx.pageContext?.tour_id) missing.push('experience interest or preferred tour');
  if (missing.length) {
    return { success: false, output: { error: 'missing_required_fields', missing } };
  }

  const insertPayload: Record<string, unknown> = {
    full_name: fullName,
    email: email || 'pending@emneladventures.com',
    phone: phone || null,
    country: (ctxRow.country as string) || null,
    travel_date: (ctxRow.start_date as string) || null,
    number_of_adults: adults,
    number_of_children: children,
    message: (ctxRow.message_summary as string) || null,
    special_requests: (ctxRow.special_interests as string[] | undefined)?.join(', ') || null,
    status: 'pending_review',
    source: 'ai_travel_advisor',
    ai_conversation_id: conversationId,
    tour_id: ctx.pageContext?.tour_id || (ctxRow.preferred_tour_id as string) || null,
    lead_context: ctxRow,
    admin_notes: (ctxRow.message_summary as string) || 'Created by Emnel AI Safari Advisor.',
    idempotency_key: idempotencyKey
  };

  const { data: created, error } = await supabase.from('booking_requests').insert(insertPayload).select('id,status').single();
  if (error || !created) {
    return { success: false, output: { error: 'Unable to create the booking request right now. A specialist can help on WhatsApp.' } };
  }

  await supabase
    .from('ai_conversations')
    .update({ booking_request_id: (created as { id: string }).id, lead_status: 'qualified', status: 'booking_request_created' })
    .eq('id', conversationId);

  return { success: true, output: { booking_request_id: (created as { id: string }).id, status: 'pending_review' } };
};

// ── get_settings ─────────────────────────────────────────────────────────────
const parseSettingValue = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

export const getSettings = async (): Promise<ToolResult> => {
  const wanted = ['whatsapp_number', 'whatsapp_default_message', 'default_response_time_message', 'contact_email', 'contact_phone', 'business_hours'];
  try {
    const { data } = await supabase.from('website_settings').select('setting_key,setting_value').eq('is_public', true).in('setting_key', wanted);
    const map: Record<string, unknown> = {};
    for (const row of (data ?? []) as Array<{ setting_key: string; setting_value: unknown }>) {
      map[row.setting_key] = parseSettingValue(row.setting_value);
    }
    return {
      success: true,
      output: {
        whatsapp_number: map.whatsapp_number ?? '',
        whatsapp_default_message: map.whatsapp_default_message ?? '',
        response_time: map.default_response_time_message ?? 'We typically respond within 24 hours.',
        contact_email: map.contact_email ?? '',
        contact_phone: map.contact_phone ?? '',
        business_hours: map.business_hours ?? ''
      }
    };
  } catch {
    return { success: true, output: { whatsapp_number: '', response_time: 'We typically respond within 24 hours.' } };
  }
};

// ── tool dispatch + audit ────────────────────────────────────────────────────
export const executeTool = async (name: string, input: Record<string, unknown>, ctx: AdvisorContext): Promise<ToolResult> => {
  let result: ToolResult;
  try {
    switch (name) {
      case 'search_tours': {
        const recs = await searchTours(input as ToursIntent, ctx);
        result = { success: true, output: { recommendations: recs } };
        break;
      }
      case 'check_availability':
        result = await checkAvailability(input);
        break;
      case 'extract_lead_context':
        result = await extractLeadContext(input, ctx);
        break;
      case 'create_booking_request':
        result = await createBookingRequest(input, ctx);
        break;
      case 'get_settings':
        result = await getSettings();
        break;
      default:
        result = { success: false, output: {}, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    result = { success: false, output: {}, error: (err as Error).message };
  }

  // Audit every tool call (best effort).
  try {
    await supabase.from('ai_tool_calls').insert({
      conversation_id: ctx.conversationId ?? null,
      tool_name: name,
      input,
      output: result.output,
      success: result.success,
      error_message: result.error ?? null
    });
  } catch {
    // ignore
  }

  return result;
};
