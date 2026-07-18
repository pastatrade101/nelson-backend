import { env } from '../config/env';
import { createMessage } from './anthropic.service';
import { logUsage } from './ai-usage.service';

// ----------------------------------------------------------------------------
// Admin content co-pilot (Phase 7). Authenticated, staff-only authoring help
// inside the CMS — drafts itineraries, descriptions, highlights, SEO and
// translations. Reuses the Anthropic service + usage logging (route
// 'admin_assist'). Unlike the customer advisor it MAY generate creative copy
// (it's a draft the admin edits), but it still must not fabricate hard facts
// (prices, exact availability, permits, guarantees) — those stay with staff.
// ----------------------------------------------------------------------------

export type AssistTask =
  | 'write_short'
  | 'write_description'
  | 'improve'
  | 'shorten'
  | 'suggest_highlights'
  | 'seo_meta'
  | 'translate_sw'
  | 'draft_itinerary';

export type AssistContext = {
  title?: string;
  destination?: string;
  duration_days?: number;
  budget_tier?: string;
  highlights?: string;
  short_description?: string;
  full_description?: string;
};

export type AssistResult = {
  task: AssistTask;
  text?: string;
  items?: string[];
  seo_title?: string;
  meta_description?: string;
  itinerary?: Array<{ day_number: number; title: string; description: string; accommodation?: string; meals?: string; activities?: string }>;
};

const SYSTEM = `You are Emnel's content co-pilot for staff using the Emnel Adventures CMS — a Tanzania safari brand (Serengeti, Ngorongoro, Kilimanjaro, Zanzibar; Kenya/Masai Mara combos). Write warm, confident, premium-but-simple marketing copy that builds traveler confidence. Be concrete and specific to Tanzania safaris. Do NOT invent or state exact prices, availability, dates, permit fees, or guarantees — staff add those. Output ONLY what is asked, with no preamble, labels, or markdown fences.`;

const ctxLine = (c: AssistContext): string => {
  const bits = [
    c.title ? `Trip: ${c.title}` : '',
    c.destination ? `Destination: ${c.destination}` : '',
    c.duration_days ? `Duration: ${c.duration_days} days` : '',
    c.budget_tier ? `Comfort tier: ${c.budget_tier}` : '',
    c.highlights ? `Highlights: ${c.highlights}` : ''
  ].filter(Boolean);
  return bits.length ? `Context — ${bits.join('; ')}.` : '';
};

// Cheap tasks → Haiku; richer generation → Sonnet.
const modelFor = (task: AssistTask): string =>
  task === 'draft_itinerary' || task === 'write_description'
    ? env.ANTHROPIC_REASONING_MODEL
    : env.ANTHROPIC_SIMPLE_MODEL;

const promptFor = (task: AssistTask, text: string, c: AssistContext, language: string): string => {
  const ctx = ctxLine(c);
  switch (task) {
    case 'write_short':
      return `${ctx}\nWrite a punchy 1–2 sentence short description (max ~240 characters) for this trip.`;
    case 'write_description':
      return `${ctx}\nWrite an engaging full description (2–3 short paragraphs) for this trip — what makes it special, who it suits, and what the experience feels like. No prices or fixed dates.`;
    case 'improve':
      return `${ctx}\nImprove the following copy — clearer, warmer, more confident, same meaning and length range. Return only the improved text:\n\n"""${text}"""`;
    case 'shorten':
      return `${ctx}\nShorten the following copy to a tight, scannable version while keeping the key appeal. Return only the shortened text:\n\n"""${text}"""`;
    case 'suggest_highlights':
      return `${ctx}\nSuggest 5–7 concise trip highlights (each 3–8 words). Return ONLY a JSON array of strings, e.g. ["...","..."]`;
    case 'seo_meta':
      return `${ctx}\nWrite an SEO title (<=60 chars) and meta description (<=155 chars) for this trip. Return ONLY JSON: {"seo_title":"...","meta_description":"..."}`;
    case 'translate_sw':
      return `Translate the following into natural, professional Swahili. Return only the translation:\n\n"""${text}"""`;
    case 'draft_itinerary':
      return `${ctx}\nDraft a realistic day-by-day itinerary with exactly ${c.duration_days ?? 7} days. For each day give a short title, a 1–2 sentence description, typical accommodation type (generic, no brand/price), and meals (e.g. "Breakfast, Lunch, Dinner"). Return ONLY a JSON array: [{"day_number":1,"title":"...","description":"...","accommodation":"...","meals":"...","activities":"..."}]`;
    default:
      return text;
  }
};

const extractJson = <T>(raw: string): T | null => {
  const match = raw.match(/[[{][\s\S]*[\]}]/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return null;
  }
};

export const runAssist = async (
  task: AssistTask,
  text: string,
  context: AssistContext,
  language: string,
  adminId?: string
): Promise<AssistResult> => {
  const model = modelFor(task);
  const res = await createMessage({
    model,
    system: SYSTEM,
    tools: [],
    maxTokens: task === 'draft_itinerary' ? 1500 : 600,
    temperature: 0.6,
    messages: [{ role: 'user', content: promptFor(task, text, context, language) }]
  });

  // Log spend against the same budget/usage ledger (admin authoring).
  void logUsage({
    conversationId: null,
    sessionId: adminId ? `admin-${adminId}` : 'admin',
    model,
    routeType: 'admin_assist',
    usage: res.usage,
    requestStatus: 'success'
  });

  const out = res.text.trim();

  if (task === 'suggest_highlights') {
    const items = extractJson<string[]>(out);
    return { task, items: Array.isArray(items) ? items.map(String) : out.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean) };
  }
  if (task === 'seo_meta') {
    const json = extractJson<{ seo_title?: string; meta_description?: string }>(out);
    return { task, seo_title: json?.seo_title ?? '', meta_description: json?.meta_description ?? '' };
  }
  if (task === 'draft_itinerary') {
    const days = extractJson<Array<Record<string, unknown>>>(out) ?? [];
    return {
      task,
      itinerary: days.map((d, i) => ({
        day_number: Number(d.day_number ?? i + 1),
        title: String(d.title ?? `Day ${i + 1}`),
        description: String(d.description ?? ''),
        accommodation: d.accommodation ? String(d.accommodation) : undefined,
        meals: d.meals ? String(d.meals) : undefined,
        activities: d.activities ? String(d.activities) : undefined
      }))
    };
  }
  return { task, text: out };
};
