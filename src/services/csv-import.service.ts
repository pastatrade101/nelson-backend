// Generic, config-driven CSV importer for the CMS bootstrap entities.
// Every entity is imported IDEMPOTENTLY: rows are matched to existing records by
// a natural key (slug, or a composite like question / client_name+message) and
// UPDATED, otherwise INSERTED. Foreign keys (destination, category, tour) are
// resolved by slug or name and created on the fly where it makes sense.
//
// Itineraries (tours + days + inclusions + pricing) have their own richer
// importer (itinerary-import.service) which this module delegates to.
import { supabase } from '../config/supabase';
import { rolePermissions, type PermissionKey } from '../config/permissions';
import { parseCsv } from './itinerary-import.service';
import { importItineraries, type ImportResult } from './itinerary-import.service';

// ── shared value helpers ────────────────────────────────────────────────────
const slugify = (v: string): string =>
  String(v ?? '').toLowerCase().trim().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
const toInt = (v: string): number | undefined => {
  const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
};
const toNum = (v: string): number | undefined => {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
const toBool = (v: string): boolean | undefined => (String(v ?? '').trim() === '' ? undefined : /^(1|true|yes|y)$/i.test(v.trim()));
const splitList = (v: string): string[] | undefined => {
  const arr = String(v ?? '').split('|').map((s) => s.trim()).filter(Boolean);
  return arr.length ? arr : undefined;
};
const normStatus = (v: string): 'draft' | 'published' | 'archived' | undefined => {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return undefined;
  return s === 'published' || s === 'archived' ? s : 'draft';
};

type FieldType = 'text' | 'int' | 'number' | 'bool' | 'list' | 'status';
type Field = { name: string; type?: FieldType; required?: boolean };
type Ref = { col: string; table: string; fk: string; create?: Record<string, unknown>; required?: boolean };
type Entity = {
  table: string;
  label: string;
  description: string;
  permission: PermissionKey;
  keys: string[]; // natural key(s) for idempotent upsert
  slugFrom?: string; // derive `slug` from this column when slug cell is empty
  userFields?: boolean; // table has created_by / updated_by
  fields: Field[];
  refs?: Ref[];
  template: { headers: string[]; example: string[] };
};

const transform = (raw: string | undefined, type: FieldType = 'text'): unknown => {
  const v = (raw ?? '').trim();
  switch (type) {
    case 'int':
      return v === '' ? undefined : toInt(v);
    case 'number':
      return v === '' ? undefined : toNum(v);
    case 'bool':
      return toBool(v);
    case 'list':
      return splitList(v);
    case 'status':
      return normStatus(v);
    default:
      return v === '' ? undefined : v;
  }
};

// ── entity registry ─────────────────────────────────────────────────────────
export const ENTITIES: Record<string, Entity> = {
  categories: {
    table: 'tour_categories',
    label: 'Safari Types / Categories',
    description: 'Safari types shown in the Safaris menu (Classic Northern Circuit, Great Migration, …).',
    permission: 'categories.create',
    keys: ['slug'],
    slugFrom: 'name',
    fields: [
      { name: 'name', required: true },
      { name: 'slug' },
      { name: 'description' },
      { name: 'who_its_for' },
      { name: 'fitness' },
      { name: 'highlights', type: 'list' },
      { name: 'image_url' },
      { name: 'sort_order', type: 'int' },
      { name: 'status', type: 'status' },
      { name: 'meta_title' },
      { name: 'meta_description' }
    ],
    template: {
      headers: ['name', 'slug', 'description', 'who_its_for', 'fitness', 'highlights', 'image_url', 'sort_order', 'status', 'meta_title', 'meta_description'],
      example: ['Great Migration', 'great-migration', 'Follow one million wildebeest across the Serengeti and Ndutu.', 'Wildlife lovers and photographers chasing the herds.', 'Easy — game drives, no walking required.', 'Calving season|River crossings|Predator action', 'https://images.unsplash.com/photo-1534177616072-ef7dc120449d', '2', 'published', 'Great Migration Safari | Emnel Adventures', 'Witness the Great Migration on a private Tanzania safari.']
    }
  },
  destinations: {
    table: 'destinations',
    label: 'Destinations / Parks',
    description: 'Parks and regions (Serengeti, Ngorongoro, Tarangire, Zanzibar, Masai Mara).',
    permission: 'destinations.create',
    keys: ['slug'],
    slugFrom: 'name',
    userFields: true,
    fields: [
      { name: 'name', required: true },
      { name: 'slug' },
      { name: 'country' },
      { name: 'region' },
      { name: 'short_description' },
      { name: 'description' },
      { name: 'image_url' },
      { name: 'main_image_url' },
      { name: 'banner_image_url' },
      { name: 'score_wildlife', type: 'number' },
      { name: 'score_luxury', type: 'number' },
      { name: 'score_family', type: 'number' },
      { name: 'score_photography', type: 'number' },
      { name: 'score_adventure', type: 'number' },
      { name: 'is_featured', type: 'bool' },
      { name: 'status', type: 'status' },
      { name: 'meta_title' },
      { name: 'meta_description' }
    ],
    template: {
      headers: ['name', 'slug', 'country', 'region', 'short_description', 'description', 'image_url', 'main_image_url', 'banner_image_url', 'score_wildlife', 'score_luxury', 'score_family', 'score_photography', 'score_adventure', 'is_featured', 'status', 'meta_title', 'meta_description'],
      example: ['Serengeti', 'serengeti', 'Tanzania', 'Northern Circuit', 'Endless plains, predator country and the Great Migration.', 'The Serengeti is the most celebrated safari landscape on earth.', 'https://images.unsplash.com/photo-1516426122078-c23e76319801', '', '', '10', '9', '8', '10', '9', 'true', 'published', 'Serengeti National Park | Emnel Adventures', 'Plan a private Serengeti safari with Emnel Adventures.']
    }
  },
  lodges: {
    table: 'lodges',
    label: 'Lodges We Love',
    description: 'Recommended lodges & camps, linked to a destination/park.',
    permission: 'lodges.create',
    keys: ['slug'],
    slugFrom: 'name',
    userFields: true,
    fields: [
      { name: 'name', required: true },
      { name: 'slug' },
      { name: 'accommodation_level' },
      { name: 'lodge_type' },
      { name: 'description' },
      { name: 'why_we_recommend' },
      { name: 'best_for', type: 'list' },
      { name: 'hero_image_url' },
      { name: 'image_url' },
      { name: 'price_per_night_from', type: 'number' },
      { name: 'currency' },
      { name: 'romantic_rating', type: 'number' },
      { name: 'family_rating', type: 'number' },
      { name: 'website_url' },
      { name: 'is_featured', type: 'bool' },
      { name: 'status', type: 'status' }
    ],
    refs: [{ col: 'destination', table: 'destinations', fk: 'destination_id', create: { status: 'published' } }],
    template: {
      headers: ['name', 'slug', 'destination', 'accommodation_level', 'lodge_type', 'description', 'why_we_recommend', 'best_for', 'hero_image_url', 'price_per_night_from', 'currency', 'romantic_rating', 'family_rating', 'website_url', 'is_featured', 'status'],
      example: ['Namiri Plains', 'namiri-plains', 'Serengeti', 'luxury', 'tented_camp', 'The best big-cat camp in the eastern Serengeti.', 'Unmatched cheetah and lion sightings; our top pick for photographers.', 'Photographers|Couples|Big cats', 'https://images.unsplash.com/photo-1523805009345-7448845a9e53', '1200', 'USD', '9', '7', 'https://example.com', 'true', 'published']
    }
  },
  'blog-categories': {
    table: 'blog_categories',
    label: 'Journal Categories',
    description: 'Categories for Journal / blog articles.',
    permission: 'blog.create',
    keys: ['slug'],
    slugFrom: 'name',
    fields: [
      { name: 'name', required: true },
      { name: 'slug' },
      { name: 'description' },
      { name: 'sort_order', type: 'int' },
      { name: 'status', type: 'status' }
    ],
    template: {
      headers: ['name', 'slug', 'description', 'sort_order', 'status'],
      example: ['Planning Guides', 'planning-guides', 'Practical guides for planning your Tanzania safari.', '1', 'published']
    }
  },
  blog: {
    table: 'blog_posts',
    label: 'Journal Articles',
    description: 'Journal / blog articles (linked to a Journal category).',
    permission: 'blog.create',
    keys: ['slug'],
    slugFrom: 'title',
    userFields: true,
    fields: [
      { name: 'title', required: true },
      { name: 'slug' },
      { name: 'excerpt' },
      { name: 'content' },
      { name: 'author_name' },
      { name: 'featured_image_url' },
      { name: 'published_at' },
      { name: 'status', type: 'status' },
      { name: 'meta_title' },
      { name: 'meta_description' }
    ],
    refs: [{ col: 'category', table: 'blog_categories', fk: 'category_id', create: { status: 'published' } }],
    template: {
      headers: ['title', 'slug', 'category', 'excerpt', 'content', 'author_name', 'featured_image_url', 'published_at', 'status', 'meta_title', 'meta_description'],
      example: ['Best Time to Visit the Serengeti', 'best-time-serengeti', 'Planning Guides', 'A month-by-month guide to the Serengeti seasons.', 'The honest answer to when to visit the Serengeti is: there is no bad time...', 'Emnel Adventures', 'https://images.unsplash.com/photo-1516426122078-c23e76319801', '2026-01-15', 'published', 'Best Time to Visit the Serengeti | Emnel Adventures', 'A month-by-month guide to the Serengeti from a local guide team.']
    }
  },
  faqs: {
    table: 'faqs',
    label: 'FAQs',
    description: 'Frequently asked questions. Leave "destination" blank for a general FAQ, or set it to attach the question to a specific destination.',
    permission: 'faqs.create',
    keys: ['question', 'destination_id'],
    fields: [
      { name: 'question', required: true },
      { name: 'answer', required: true },
      { name: 'category' },
      { name: 'sort_order', type: 'int' },
      { name: 'status', type: 'status' }
    ],
    refs: [{ col: 'destination', table: 'destinations', fk: 'destination_id', create: { status: 'published' } }],
    template: {
      headers: ['question', 'answer', 'category', 'destination', 'sort_order', 'status'],
      example: ['Is the Serengeti worth visiting outside migration season?', 'Yes — resident wildlife keeps game viewing strong year-round, particularly in Central Serengeti and the east, with fewer vehicles and better rates.', 'General', 'serengeti', '1', 'published']
    }
  },
  pricing: {
    table: 'tour_price_options',
    label: 'Pricing Options',
    description: 'Price tiers for existing tours (matched to a tour by slug). Add/update tiers without touching the rest of the tour.',
    permission: 'tours.create',
    keys: ['tour_id', 'label'],
    fields: [
      { name: 'label', required: true },
      { name: 'title', required: true },
      { name: 'price', type: 'number' },
      { name: 'currency' },
      { name: 'price_type' },
      { name: 'description' },
      { name: 'sort_order', type: 'int' }
    ],
    refs: [{ col: 'tour', table: 'tours', fk: 'tour_id', required: true }],
    template: {
      headers: ['tour', 'label', 'title', 'price', 'currency', 'price_type', 'description', 'sort_order'],
      example: ['classic-northern-circuit', 'Signature', 'Signature — Premium camps', '5500', 'USD', 'per_person', 'Melia Serengeti, andBeyond camps. 7 nights, 2 pax sharing.', '2']
    }
  },
  testimonials: {
    table: 'testimonials',
    label: 'Testimonials',
    description: 'Guest reviews (optionally linked to a tour by slug).',
    permission: 'testimonials.create',
    keys: ['client_name', 'message'],
    fields: [
      { name: 'client_name', required: true },
      { name: 'client_country' },
      { name: 'client_image_url' },
      { name: 'rating', type: 'int' },
      { name: 'message', required: true },
      { name: 'is_featured', type: 'bool' },
      { name: 'sort_order', type: 'int' },
      { name: 'status', type: 'status' }
    ],
    refs: [{ col: 'tour', table: 'tours', fk: 'tour_id' }],
    template: {
      headers: ['client_name', 'client_country', 'client_image_url', 'rating', 'message', 'tour', 'is_featured', 'sort_order', 'status'],
      example: ['Melanie W.', 'Germany', '', '5', 'Nelson arranged a private bush dinner for our anniversary that I will never forget.', 'classic-northern-circuit', 'true', '1', 'published']
    }
  }
};

export const listEntities = () =>
  Object.entries(ENTITIES).map(([key, e]) => ({
    key,
    label: e.label,
    description: e.description,
    keys: e.keys,
    headers: e.template.headers,
    example: e.template.example
  }));

const csvEsc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const buildTemplate = (entityKey: string): string => {
  const e = ENTITIES[entityKey];
  if (!e) throw new Error(`Unknown import type "${entityKey}".`);
  return `${e.template.headers.join(',')}\n${e.template.example.map(csvEsc).join(',')}\n`;
};

export const hasPermission = (role: string, entityKey: string): boolean => {
  if (role === 'super_admin') return true;
  const perm: PermissionKey | undefined =
    entityKey === 'itineraries' || entityKey === 'tours' ? 'tours.create' : ENTITIES[entityKey]?.permission;
  if (!perm) return false;
  return Boolean(rolePermissions[role as keyof typeof rolePermissions]?.includes(perm));
};

// ── content reset (start-fresh) ─────────────────────────────────────────────
// Clears the importable CONTENT only. Deleting `tours` cascades to its children
// (itinerary_days, inclusions, exclusions, price_options, images, dates). Ordered
// so referencing rows go before the rows they point at. Does NOT touch admin
// users, roles, branding, settings or homepage sections.
export const RESET_TABLES = [
  'testimonials',
  'faqs',
  'blog_posts',
  'blog_categories',
  'lodges',
  'tours',
  'tour_categories',
  'destinations'
] as const;

export type ResetResult = { table: string; deleted: number; error?: string };

export const resetContent = async (): Promise<ResetResult[]> => {
  const out: ResetResult[] = [];
  for (const table of RESET_TABLES) {
    const { count } = await supabase.from(table).select('id', { count: 'exact', head: true });
    const { error } = await supabase.from(table).delete().not('id', 'is', null);
    out.push({ table, deleted: error ? 0 : count ?? 0, ...(error ? { error: error.message } : {}) });
  }
  return out;
};

// ── foreign-key resolution ──────────────────────────────────────────────────
const resolveRef = async (ref: Ref, value: string, warnings: string[]): Promise<string | null> => {
  const name = value.trim();
  if (!name) return null;
  const slug = slugify(name);

  const bySlug = await supabase.from(ref.table).select('id').eq('slug', slug).limit(1).maybeSingle();
  if (bySlug.data) return bySlug.data.id;
  const byName = await supabase.from(ref.table).select('id').ilike('name', name).limit(1).maybeSingle();
  if (byName.data) return byName.data.id;

  if (!ref.create) {
    warnings.push(`${ref.col} "${name}" not found; left unset.`);
    return null;
  }
  const created = await supabase.from(ref.table).insert({ name, slug, ...ref.create }).select('id').single();
  if (created.error) {
    warnings.push(`${ref.col} "${name}" could not be created (${created.error.message}); left unset.`);
    return null;
  }
  warnings.push(`Created ${ref.col} "${name}".`);
  return created.data.id;
};

// ── main entry ───────────────────────────────────────────────────────────────
export const importEntity = async (entityKey: string, csvText: string, userId?: string): Promise<ImportResult> => {
  // Itineraries have a dedicated, richer importer.
  if (entityKey === 'itineraries' || entityKey === 'tours') {
    return importItineraries(csvText, userId);
  }

  const cfg = ENTITIES[entityKey];
  if (!cfg) throw new Error(`Unknown import type "${entityKey}".`);

  const rows = parseCsv(csvText);
  const results: ImportResult['results'] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const line = i + 2;
    try {
      const warnings: string[] = [];
      const payload: Record<string, unknown> = {};

      for (const f of cfg.fields) {
        if (f.name === 'slug' && cfg.slugFrom) {
          payload.slug = slugify(r.slug || r[cfg.slugFrom] || '');
          continue;
        }
        const value = transform(r[f.name], f.type);
        if (f.required && (value === undefined || value === '')) {
          throw new Error(`Missing required "${f.name}".`);
        }
        if (value !== undefined) payload[f.name] = value;
      }

      for (const ref of cfg.refs ?? []) {
        if (r[ref.col]) {
          const id = await resolveRef(ref, r[ref.col], warnings);
          if (ref.required && !id) throw new Error(`${ref.col} "${r[ref.col]}" was not found.`);
          payload[ref.fk] = id;
        } else if (ref.required) {
          throw new Error(`Missing required "${ref.col}".`);
        }
      }

      // idempotent match on the natural key(s). A null key part (e.g. a general
      // FAQ with no destination) is matched with IS NULL, not = null.
      let query = supabase.from(cfg.table).select('id');
      for (const k of cfg.keys) {
        const v = payload[k];
        query = v === null || v === undefined ? query.is(k, null) : query.eq(k, v as string);
      }
      const existing = await query.limit(1).maybeSingle();

      const title = String(payload.title ?? payload.name ?? payload.question ?? payload.client_name ?? '');
      let action: 'created' | 'updated';
      if (existing.data) {
        const update: Record<string, unknown> = { ...payload, updated_at: new Date().toISOString() };
        if (cfg.userFields && userId) update.updated_by = userId;
        const { error } = await supabase.from(cfg.table).update(update).eq('id', existing.data.id);
        if (error) throw new Error(error.message);
        action = 'updated';
      } else {
        const insert: Record<string, unknown> = { ...payload };
        if (cfg.userFields && userId) {
          insert.created_by = userId;
          insert.updated_by = userId;
        }
        const { error } = await supabase.from(cfg.table).insert(insert);
        if (error) throw new Error(error.message);
        action = 'created';
      }

      results.push({ line, status: 'ok', action, title, slug: String(payload.slug ?? ''), warnings: warnings.length ? warnings : undefined });
    } catch (err) {
      results.push({ line, status: 'error', title: r.title || r.name || r.question || r.client_name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    summary: {
      total: results.length,
      created: results.filter((x) => x.action === 'created').length,
      updated: results.filter((x) => x.action === 'updated').length,
      failed: results.filter((x) => x.status === 'error').length
    },
    results
  };
};
