import { supabase } from '../config/supabase';
import { normalizeTier } from '../utils/tiers';

type LeadContext = {
  budget_tier?: string;
  destination?: string;
  duration_days?: number;
  persona_tags?: string[];
};

const normalized = (value?: string) => value?.trim().toLowerCase();

const arrayValue = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

export const matchToursForLead = async (context: LeadContext) => {
  const { data, error } = await supabase
    .from('tours')
    .select('id,title,slug,short_description,persona_tags,duration_days,budget_tier,price_from,currency,is_available,seats_remaining,destinations(name,slug,country)')
    .eq('is_available', true)
    .is('deleted_at', null)
    .limit(12);

  if (error || !data) return [];

  return data
    .map((tour) => {
      let score = 0;
      const personaTags = arrayValue(tour.persona_tags).map((tag) => normalized(tag));
      const leadTags = (context.persona_tags ?? []).map((tag) => normalized(tag));
      const hasPersonaMatch = leadTags.some((tag) => tag && personaTags.includes(tag));
      if (hasPersonaMatch) score += 40;

      const destination = normalized(context.destination);
      const tourDestination = Array.isArray(tour.destinations) ? tour.destinations[0] : tour.destinations;
      const destinationName = normalized((tourDestination as { name?: string; country?: string } | null)?.name);
      const destinationCountry = normalized((tourDestination as { name?: string; country?: string } | null)?.country);
      if (destination && (destination === destinationName || destination === destinationCountry)) score += 30;

      if (context.duration_days && typeof tour.duration_days === 'number' && Math.abs(tour.duration_days - context.duration_days) <= 2) {
        score += 20;
      }

      if (normalizeTier(context.budget_tier) && normalizeTier(context.budget_tier) === normalizeTier(tour.budget_tier as string)) score += 10;
      if (typeof tour.seats_remaining === 'number' && tour.seats_remaining < 5) score += 5;

      return {
        score,
        tour
      };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
};
