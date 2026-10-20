import { supabase } from '../config/supabase';
import { FAQ_ENTITY_TYPES, type FaqEntityType } from '../schemas/faqs.schema';
import { asyncHandler } from '../utils/async-handler';
import { createRecord, getRecordById, listRecords, softDeleteRecord, updateRecord } from '../utils/supabase-helpers';

const select = '*, destinations(name,slug)';

// The column that holds a human name, per attachable collection. Only tours
// calls it `title`; everything else is `name`.
const LABEL_COLUMN: Record<FaqEntityType, string> = {
  destinations: 'name',
  tours: 'title',
  tour_categories: 'name',
  lodges: 'name',
  travel_styles: 'name'
};

const isEntityType = (value: unknown): value is FaqEntityType =>
  typeof value === 'string' && (FAQ_ENTITY_TYPES as readonly string[]).includes(value);

/**
 * Resolve `entity_type` + `entity_id` into a readable `entity` object, so a
 * list of FAQs can say "Serengeti National Park" instead of a bare uuid. A
 * polymorphic pair can't be embedded the way a foreign key can, so this is one
 * batched query per collection present in the page — at most five, usually one.
 *
 * Non-fatal by design: a lookup that fails leaves `entity` null and the FAQ
 * still renders. An attachment pointing at a deleted record resolves to null
 * too, which is exactly what the admin should see.
 */
const attachEntityLabels = async (items: Array<Record<string, unknown>>) => {
  const idsByType = new Map<FaqEntityType, Set<string>>();

  for (const row of items) {
    const type = row.entity_type;
    const id = row.entity_id;
    if (!isEntityType(type) || typeof id !== 'string' || !id) continue;
    if (!idsByType.has(type)) idsByType.set(type, new Set());
    idsByType.get(type)?.add(id);
  }
  if (!idsByType.size) return;

  const resolved = new Map<string, { id: string; label: string; slug: string | null; type: FaqEntityType }>();

  await Promise.all(
    [...idsByType].map(async ([type, ids]) => {
      const column = LABEL_COLUMN[type];
      // A soft-deleted record is gone as far as the site is concerned, so it
      // resolves to null and the admin sees "Missing record".
      const { data, error } = await supabase
        .from(type)
        .select(`id, slug, ${column}`)
        .in('id', [...ids])
        .is('deleted_at', null);
      if (error || !data) return;

      for (const record of data as unknown as Array<Record<string, unknown>>) {
        const id = String(record.id);
        resolved.set(`${type}:${id}`, {
          id,
          type,
          label: String(record[column] ?? ''),
          slug: typeof record.slug === 'string' ? record.slug : null
        });
      }
    })
  );

  for (const row of items) {
    const type = row.entity_type;
    const id = row.entity_id;
    row.entity = isEntityType(type) && typeof id === 'string' ? resolved.get(`${type}:${id}`) ?? null : null;
  }
};

export const listFaqs = asyncHandler(async (req, res) => {
  return listRecords(req, res, {
    table: 'faqs',
    select,
    searchColumns: ['question', 'answer', 'category'],
    statusColumn: 'status',
    defaultStatus: 'published',
    // `entity_type=null` returns the general questions — the ones shown where
    // nothing more specific has been attached.
    filters: ['category', 'destination_id', 'entity_type', 'entity_id'],
    orderBy: 'sort_order',
    ascending: true,
    tieBreaker: 'id',
    afterFetch: attachEntityLabels
  });
});

export const getFaq = asyncHandler(async (req, res) => {
  return getRecordById(res, 'faqs', req.params.id, select);
});

/**
 * `destination_id` predates the generic attachment and is still filtered on, so
 * it is kept as a mirror of the pair rather than left to drift: attach to a
 * destination and it is set, attach anywhere else (or nowhere) and it is
 * cleared. Only touched when the payload carries an attachment, so a partial
 * update that says nothing about it leaves it alone.
 */
const withMirroredDestination = (body: Record<string, unknown>) => {
  if (!('entity_type' in body) && !('entity_id' in body)) return body;
  return {
    ...body,
    destination_id: body.entity_type === 'destinations' ? body.entity_id ?? null : null
  };
};

export const createFaq = asyncHandler(async (req, res) => {
  return createRecord(req, res, 'faqs', withMirroredDestination(req.body));
});

export const updateFaq = asyncHandler(async (req, res) => {
  return updateRecord(req, res, 'faqs', req.params.id, withMirroredDestination(req.body));
});

export const deleteFaq = asyncHandler(async (req, res) => {
  return softDeleteRecord(res, 'faqs', req.params.id, req);
});
