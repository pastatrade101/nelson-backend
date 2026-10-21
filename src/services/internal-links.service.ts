import { supabase } from '../config/supabase';
import { cleanSearch } from '../utils/query';
import { extractAnchors, isSitePath, pathOf, repointAnchors } from '../utils/internal-link-html';

/**
 * Internal links for admin-authored rich text: what can be linked to, where each
 * of those pages lives, and whether the links already written still lead
 * somewhere.
 *
 * Keys are table names — the same spelling the editor stores in a link's
 * `data-link-type` and the FAQ attachments use. `base` is the public route the
 * record is published under; the visitor-facing words (accommodation,
 * experiences, compare) differ from the table names on purpose.
 */
export const LINK_TARGETS = {
  tours: { title: 'title', base: '/tours', label: 'Itinerary', keywords: ['short_description'] },
  destinations: { title: 'name', base: '/destinations', label: 'Destination', keywords: ['short_description', 'country'] },
  lodges: { title: 'name', base: '/accommodation', label: 'Accommodation', keywords: ['short_description'] },
  tour_categories: { title: 'name', base: '/experiences', label: 'Experience', keywords: [] },
  travel_styles: { title: 'name', base: '/travel-styles', label: 'Travel style', keywords: [] },
  blog_posts: { title: 'title', base: '/blog', label: 'Journal', keywords: ['excerpt'] },
  safari_essentials: { title: 'title', base: '/safari-essentials', label: 'Safari essentials', keywords: [] },
  comparisons: { title: 'title', base: '/compare', label: 'Comparison', keywords: ['intro'] },
  market_pages: { title: 'name', base: '/safaris', label: 'Market page', keywords: [] }
} as const;

export type LinkType = keyof typeof LINK_TARGETS;
export const LINK_TYPES = Object.keys(LINK_TARGETS) as LinkType[];
export const isLinkType = (value: unknown): value is LinkType =>
  typeof value === 'string' && (LINK_TYPES as string[]).includes(value);

/** Rich-text columns that hold editor links, and so are scanned and repointed. */
const HTML_FIELDS = [
  { table: 'tours', column: 'full_description', softDelete: true },
  { table: 'itinerary_days', column: 'description', softDelete: false }
] as const;

export type LinkTargetRow = {
  type: LinkType;
  id: string;
  title: string;
  path: string;
  label: string;
};

type Row = Record<string, unknown>;

const pathFor = (type: LinkType, slug: unknown) => `${LINK_TARGETS[type].base}/${String(slug ?? '')}`;

/** PostgREST `or()` takes a comma/paren syntax, so those characters can't reach it. */
const safeTerm = (value: string) => cleanSearch(value).replace(/[()*\\"]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Published pages matching `q`, best match first.
 *
 * Only published, non-deleted records are ever returned — the picker exists so
 * a link resolves by construction, and a draft is a page visitors would hit as
 * a 404. Ranking is deterministic: exact title, title prefix, a title word
 * prefix, then slug and keyword matches.
 */
export const searchLinkTargets = async ({
  q,
  type,
  page = 1,
  limit = 20
}: {
  q: string;
  type?: LinkType;
  page?: number;
  limit?: number;
}) => {
  const term = safeTerm(q).slice(0, 80);
  const types = type ? [type] : LINK_TYPES;
  const perType = 40;

  const batches = await Promise.all(
    types.map(async (t) => {
      const cfg = LINK_TARGETS[t];
      const columns = [cfg.title, 'slug', ...cfg.keywords];
      let query = supabase
        .from(t)
        .select(`id, slug, ${cfg.title}`)
        .is('deleted_at', null)
        .eq('status', 'published')
        .order(cfg.title, { ascending: true })
        .limit(perType);
      if (term) query = query.or(columns.map((c) => `${c}.ilike.%${term}%`).join(','));
      const { data, error } = await query;
      if (error) return [] as LinkTargetRow[];
      return ((data ?? []) as unknown as Row[])
        .filter((row) => typeof row.slug === 'string' && row.slug)
        .map((row) => ({
          type: t,
          id: String(row.id),
          title: String(row[cfg.title] ?? row.slug).replace(/\s+/g, ' ').trim(),
          path: pathFor(t, row.slug),
          label: cfg.label
        }));
    })
  );

  const needle = term.toLowerCase();
  const rank = (row: LinkTargetRow) => {
    if (!needle) return 5;
    const title = row.title.toLowerCase();
    if (title === needle) return 0;
    if (title.startsWith(needle)) return 1;
    if (title.split(/[^a-z0-9]+/).some((word) => word.startsWith(needle))) return 2;
    if (title.includes(needle)) return 3;
    if (row.path.toLowerCase().includes(needle.replace(/\s+/g, '-'))) return 4;
    return 5; // matched on a keyword column only
  };

  const all = batches
    .flat()
    .map((row) => ({ row, score: rank(row) }))
    .sort((a, b) => a.score - b.score || a.row.title.localeCompare(b.row.title))
    .map(({ row }) => row);

  const size = Math.min(Math.max(limit, 1), 50);
  const current = Math.max(page, 1);
  const from = (current - 1) * size;
  return {
    items: all.slice(from, from + size),
    pagination: { page: current, limit: size, total: all.length, totalPages: Math.max(Math.ceil(all.length / size), 1) }
  };
};

export type ResolvedRef = {
  type: LinkType;
  id: string;
  title: string | null;
  path: string | null;
  /** 'published' is the only state a link may point at. */
  state: 'published' | 'draft' | 'archived' | 'deleted' | 'missing';
};

/** Current title, address and state of each referenced record, keyed `${type}:${id}`. */
export const resolveLinkRefs = async (refs: Array<{ type: string; id: string }>): Promise<Record<string, ResolvedRef>> => {
  const byType = new Map<LinkType, Set<string>>();
  for (const ref of refs) {
    if (!isLinkType(ref.type) || typeof ref.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(ref.id)) continue;
    if (!byType.has(ref.type)) byType.set(ref.type, new Set());
    byType.get(ref.type)?.add(ref.id);
  }

  const out: Record<string, ResolvedRef> = {};
  await Promise.all(
    [...byType].map(async ([type, ids]) => {
      const cfg = LINK_TARGETS[type];
      const { data, error } = await supabase
        .from(type)
        .select(`id, slug, status, deleted_at, ${cfg.title}`)
        .in('id', [...ids]);
      const found = new Map(((error ? [] : data ?? []) as unknown as Row[]).map((row) => [String(row.id), row]));
      for (const id of ids) {
        const row = found.get(id);
        const state: ResolvedRef['state'] = !row
          ? 'missing'
          : row.deleted_at
            ? 'deleted'
            : row.status === 'published'
              ? 'published'
              : row.status === 'archived'
                ? 'archived'
                : 'draft';
        out[`${type}:${id}`] = {
          type,
          id,
          title: row ? String(row[cfg.title] ?? row.slug ?? '') : null,
          path: row?.slug ? pathFor(type, row.slug) : null,
          state
        };
      }
    })
  );
  return out;
};

/**
 * After a record's slug changes, point every referenced link at its new address
 * in the rich-text fields. Only the href changes; anchor text is the editor's.
 * Returns how many links moved. Never throws — a failed repoint leaves the old
 * address, which the 404 redirect and the link-health report both catch.
 */
export const repointLinksTo = async (type: LinkType, id: string, newPath: string): Promise<number> => {
  let moved = 0;
  for (const field of HTML_FIELDS) {
    try {
      let query = supabase
        .from(field.table)
        .select(`id, ${field.column}`)
        .ilike(field.column, `%data-link-id="${id}"%`);
      if (field.softDelete) query = query.is('deleted_at', null);
      const { data } = await query;
      for (const row of (data ?? []) as unknown as Row[]) {
        const { html, changed } = repointAnchors(String(row[field.column] ?? ''), id, newPath);
        if (!changed) continue;
        const { error } = await supabase.from(field.table).update({ [field.column]: html }).eq('id', row.id);
        if (!error) moved += changed;
      }
    } catch {
      // Non-fatal: see above.
    }
  }
  return moved;
};

/** Called by updateRecord: repoint links when a linkable record's slug changed. */
export const repointAfterSlugChange = async (table: string, previous: Row | null, next: Row | null) => {
  if (!isLinkType(table) || !previous || !next) return 0;
  if (!previous.slug || !next.slug || previous.slug === next.slug) return 0;
  return repointLinksTo(table, String(next.id), pathFor(table, next.slug));
};

export type LinkIssueKind = 'broken' | 'unpublished' | 'moved' | 'duplicate' | 'self' | 'generic';

export type LinkHealthIssue = {
  kind: LinkIssueKind;
  message: string;
  href: string;
  text: string;
  /** Where the link is: the tour, and the day when it is in an itinerary day. */
  tour: { id: string; title: string; slug: string };
  day: { id: string; number: number; title: string } | null;
  /** For a moved link: the address it should have now. */
  fixHref?: string;
};

/** Anchor text that tells neither readers nor search engines where a link goes. */
export const GENERIC_ANCHORS = new Set([
  'click here', 'here', 'click', 'read more', 'more', 'this', 'this link', 'link', 'learn more',
  'see more', 'find out more', 'this page', 'go', 'details', 'more info', 'more information'
]);

/**
 * Every internal link in tour descriptions and itinerary days, checked against
 * the live site: addresses that lead nowhere, pages that were unpublished or
 * deleted, pages whose slug changed since the link was written, the same page
 * linked more than once in one text, a tour linking to itself, and anchors like
 * "click here". Read-only.
 */
export const scanLinkHealth = async () => {
  const [{ data: tourRows }, { data: dayRows }] = await Promise.all([
    supabase.from('tours').select('id, title, slug, full_description').is('deleted_at', null),
    supabase.from('itinerary_days').select('id, tour_id, day_number, title, description')
  ]);
  const tours = (tourRows ?? []) as unknown as Row[];
  const tourById = new Map(tours.map((t) => [String(t.id), t]));

  // Everything a link could point at, published or not, by path and by id.
  const records = await Promise.all(
    LINK_TYPES.map(async (type) => {
      const { data } = await supabase.from(type).select('id, slug, status, deleted_at');
      return ((data ?? []) as unknown as Row[]).map((row) => ({ type, row }));
    })
  );
  const byPath = new Map<string, { type: LinkType; row: Row }>();
  const byRef = new Map<string, { type: LinkType; row: Row }>();
  for (const { type, row } of records.flat()) {
    if (row.slug && !row.deleted_at) {
      const path = pathFor(type, row.slug);
      // A published record wins a path that a draft shares.
      const held = byPath.get(path);
      if (!held || (held.row.status !== 'published' && row.status === 'published')) byPath.set(path, { type, row });
    }
    byRef.set(`${type}:${row.id}`, { type, row });
  }
  const linkableBases = new Set<string>(LINK_TYPES.map((type) => LINK_TARGETS[type].base));

  const issues: LinkHealthIssue[] = [];
  let links = 0;

  const check = (html: string, tour: Row, day: Row | null) => {
    const seen = new Map<string, number>();
    const selfPath = pathFor('tours', tour.slug);
    for (const anchor of extractAnchors(html)) {
      if (!isSitePath(anchor.href)) continue;
      links += 1;
      const base = {
        href: anchor.href,
        text: anchor.text,
        tour: { id: String(tour.id), title: String(tour.title ?? ''), slug: String(tour.slug ?? '') },
        day: day ? { id: String(day.id), number: Number(day.day_number ?? 0), title: String(day.title ?? '') } : null
      };
      const path = pathOf(anchor.href);
      const ref = anchor.linkType && anchor.linkId ? byRef.get(`${anchor.linkType}:${anchor.linkId}`) : undefined;
      const target = ref ?? byPath.get(path);
      const key = target ? `${target.type}:${target.row.id}` : path;
      seen.set(key, (seen.get(key) ?? 0) + 1);

      if (GENERIC_ANCHORS.has(anchor.text.toLowerCase())) {
        issues.push({ ...base, kind: 'generic', message: `"${anchor.text}" doesn't say where the link goes — use words that name the page.` });
      }
      if (path === selfPath) {
        issues.push({ ...base, kind: 'self', message: 'Links to this same tour page.' });
        continue;
      }
      if (seen.get(key) === 2) {
        issues.push({ ...base, kind: 'duplicate', message: 'The same page is linked more than once here — once is enough.' });
      }

      if (anchor.linkId && anchor.linkType && !ref) {
        issues.push({ ...base, kind: 'broken', message: 'The page this link was made for no longer exists.' });
        continue;
      }
      if (target) {
        if (target.row.deleted_at) {
          issues.push({ ...base, kind: 'broken', message: 'Links to a page that was deleted.' });
        } else if (target.row.status !== 'published') {
          issues.push({ ...base, kind: 'unpublished', message: `Links to a page that is ${String(target.row.status ?? 'not published')} — visitors get a 404.` });
        } else if (ref) {
          const current = pathFor(target.type, target.row.slug);
          if (current !== path) {
            issues.push({ ...base, kind: 'moved', message: `That page moved to ${current}.`, fixHref: current });
          }
        }
        continue;
      }
      // No record behind it: only judge addresses under a section we can list.
      const section = `/${path.split('/').filter(Boolean)[0] ?? ''}`;
      if (linkableBases.has(section) && path.split('/').filter(Boolean).length === 2) {
        issues.push({ ...base, kind: 'broken', message: 'No page at this address.' });
      }
    }
  };

  for (const tour of tours) check(String(tour.full_description ?? ''), tour, null);
  for (const day of (dayRows ?? []) as unknown as Row[]) {
    const tour = tourById.get(String(day.tour_id));
    if (tour) check(String(day.description ?? ''), tour, day);
  }

  return { checked: { tours: tours.length, days: (dayRows ?? []).length, links }, issues };
};

/** Repoint every referenced link whose page moved. Returns how many links changed. */
export const repairMovedLinks = async () => {
  const { issues } = await scanLinkHealth();
  const moved = new Map<string, string>();
  // The scan reports by address; the fix is per referenced record.
  const [{ data: tourRows }, { data: dayRows }] = await Promise.all([
    supabase.from('tours').select('full_description').is('deleted_at', null),
    supabase.from('itinerary_days').select('description')
  ]);
  const wanted = new Set(issues.filter((i) => i.kind === 'moved').map((i) => i.href));
  for (const html of [
    ...((tourRows ?? []) as unknown as Row[]).map((r) => String(r.full_description ?? '')),
    ...((dayRows ?? []) as unknown as Row[]).map((r) => String(r.description ?? ''))
  ]) {
    for (const anchor of extractAnchors(html)) {
      if (anchor.linkId && isLinkType(anchor.linkType) && wanted.has(anchor.href)) {
        moved.set(`${anchor.linkType}:${anchor.linkId}`, anchor.linkType);
      }
    }
  }
  const resolved = await resolveLinkRefs([...moved.keys()].map((key) => {
    const [type, id] = key.split(':');
    return { type, id };
  }));
  let changed = 0;
  for (const ref of Object.values(resolved)) {
    if (ref.state === 'published' && ref.path) changed += await repointLinksTo(ref.type, ref.id, ref.path);
  }
  return { changed };
};
