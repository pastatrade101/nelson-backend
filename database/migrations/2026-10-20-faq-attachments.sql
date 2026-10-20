-- Let an FAQ belong to something — one central FAQ library, each question
-- attached to the page it answers (Goldfinch's design, 2026-09-10).
--
-- Until now a question could be attached to a destination and nothing else, so
-- every tour page, safari style and lodge read the same general list. A pair of
-- columns rather than one nullable foreign key per table, so attaching FAQs to
-- another collection later is a check-constraint change, not a new column.
--
--   entity_type null  -> a general question, shown wherever nothing more
--                        specific applies. Unchanged for every existing row.
--   entity_type set   -> belongs to that record, and only that record.
--
-- Emnel's attachable collections are the ones with a public page of their own:
-- destinations, tours, tour categories (safari styles), lodges (accommodation)
-- and travel styles.
--
-- Also caps question and answer length, so CMS input cannot break the
-- accordion layout. Every existing FAQ is well inside these (longest question
-- 92, longest answer 359 characters as of 2026-10-20). NOT VALID skips the
-- re-check of old rows; new and edited rows are checked.
--
-- Idempotent and additive. Safe to run on the live database, safe to re-run.

begin;

alter table faqs add column if not exists entity_type text;
alter table faqs add column if not exists entity_id uuid;

alter table faqs drop constraint if exists faqs_entity_type_check;
alter table faqs add constraint faqs_entity_type_check
  check (entity_type is null or entity_type in (
    'destinations', 'tours', 'tour_categories', 'lodges', 'travel_styles'
  ));

-- Both halves or neither: a type with no id would match every record of that
-- type; an id with no type is unresolvable.
alter table faqs drop constraint if exists faqs_entity_pair_check;
alter table faqs add constraint faqs_entity_pair_check
  check ((entity_type is null and entity_id is null) or (entity_type is not null and entity_id is not null));

alter table faqs drop constraint if exists faqs_question_length_check;
alter table faqs add constraint faqs_question_length_check check (char_length(question) <= 150) not valid;
alter table faqs drop constraint if exists faqs_answer_length_check;
alter table faqs add constraint faqs_answer_length_check check (char_length(answer) <= 600) not valid;

-- Carry the existing destination links over. destination_id stays and keeps
-- working; only rows not already attached are touched, so a re-run cannot
-- overwrite a later, deliberate attachment.
update faqs
   set entity_type = 'destinations',
       entity_id = destination_id
 where destination_id is not null
   and entity_type is null;

create index if not exists idx_faqs_entity on faqs (entity_type, entity_id) where deleted_at is null;
create index if not exists idx_faqs_entity_published
  on faqs (entity_type, entity_id, sort_order) where deleted_at is null and status = 'published';

commit;

notify pgrst, 'reload schema';
