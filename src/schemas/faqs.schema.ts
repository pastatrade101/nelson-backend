import { z } from 'zod';

/**
 * What an FAQ can be attached to — the Emnel collections with a public page of
 * their own. Plural table names, matching the `faqs_entity_type_check`
 * constraint (migration 2026-10-20-faq-attachments); adding a collection means
 * adding it there too, since the database is what actually enforces this.
 */
export const FAQ_ENTITY_TYPES = ['destinations', 'tours', 'tour_categories', 'lodges', 'travel_styles'] as const;

export type FaqEntityType = (typeof FAQ_ENTITY_TYPES)[number];

/**
 * Lengths the public accordion is designed around. The admin form counts down
 * to the same numbers, so an editor sees the limit before the API refuses it.
 * Every existing FAQ is inside them (longest: question 92, answer 359).
 */
export const FAQ_QUESTION_MAX = 150;
export const FAQ_ANSWER_MAX = 600;

const faqBase = z.object({
  question: z.string().trim().min(5).max(FAQ_QUESTION_MAX, `Keep the question to ${FAQ_QUESTION_MAX} characters.`),
  answer: z.string().trim().min(5).max(FAQ_ANSWER_MAX, `Keep the answer to ${FAQ_ANSWER_MAX} characters.`),
  category: z.string().trim().max(60).optional().nullable(),
  destination_id: z.string().uuid().optional().nullable(),
  entity_type: z.enum(FAQ_ENTITY_TYPES).optional().nullable(),
  entity_id: z.string().uuid().optional().nullable(),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  sort_order: z.coerce.number().int().min(0).default(0)
});

/**
 * The attachment is a pair: a type with no id would match every record of that
 * type, an id with no type is unresolvable. The database says the same thing,
 * but catching it here turns a constraint violation into a 400 an editor can
 * read. Sending neither key leaves an existing attachment alone; sending one
 * without the other is rejected, since "detach" has to clear both.
 */
const requireEntityPair = (
  value: { entity_type?: string | null; entity_id?: string | null },
  ctx: z.RefinementCtx
) => {
  const hasType = 'entity_type' in value;
  const hasId = 'entity_id' in value;
  if (!hasType && !hasId) return;

  if (hasType !== hasId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasType ? 'entity_id' : 'entity_type'],
      message: 'entity_type and entity_id must be sent together.'
    });
    return;
  }

  if (Boolean(value.entity_type) !== Boolean(value.entity_id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['entity_id'],
      message: 'Choose both what this FAQ is attached to and which record, or neither.'
    });
  }
};

export const faqCreateSchema = faqBase.superRefine(requireEntityPair);
export const faqUpdateSchema = faqBase.partial().superRefine(requireEntityPair);
