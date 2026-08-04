// Comfort tiers — backend mirror of the frontend $lib/tiers. Client vocabulary:
// Essential · Classic · Luxury · Ultra Luxury. `normalizeTier` maps every
// historical value (budget, mid_range, luxury_plus, comfortable, …) onto the new
// keys so AI tour-matching keeps working before/after the DB is migrated.

export type TierKey = 'essential' | 'classic' | 'luxury' | 'ultra_luxury';

const ALIAS: Record<string, TierKey> = {
  budget: 'essential', comfortable: 'essential', essential: 'essential',
  mid_range: 'classic', midrange: 'classic', standard: 'classic', classic: 'classic',
  luxury: 'luxury',
  luxury_plus: 'ultra_luxury', luxuryplus: 'ultra_luxury', ultra_luxury: 'ultra_luxury', ultraluxury: 'ultra_luxury'
};

/** Map any stored/requested tier value onto a canonical key ('' when unknown/empty). */
export const normalizeTier = (v?: string | null): TierKey | '' => {
  if (!v) return '';
  const k = String(v).toLowerCase().trim().replace(/[\s-]+/g, '_');
  return ALIAS[k] ?? '';
};
