-- Let a guest information form exist WITHOUT a booking record.
--
-- The first cut tied every form to booking_requests, which is wrong for how the
-- office actually works: an enquiry is often confirmed over WhatsApp long before
-- anyone creates the booking row, and the passport details are needed first — the
-- lodges and flights cannot be held without them.
--
-- So a submission may now stand alone, identified by a label the office types
-- ("Miller family, Nov 2026"), and is linked to a booking later if one exists.
--
-- Additive and idempotent. Existing submissions keep their booking_id.

-- ── A submission no longer requires a booking ─────────────────────────────
alter table guest_detail_submissions
  alter column booking_id drop not null;

-- How the office recognises a standalone form in a list. Required in practice
-- for standalone forms, but nullable in the schema because a booking-backed
-- submission takes its identity from the booking instead.
alter table guest_detail_submissions
  add column if not exists label text;

comment on column guest_detail_submissions.label is
  'Office-facing name for a form with no booking, e.g. "Miller family, Nov 2026".';

-- The old UNIQUE(booking_id) allowed only one NULL row in some engines and, more
-- importantly, stopped a second standalone form existing at all. Replaced with a
-- partial unique index so the "one form per booking" rule still holds for
-- booking-backed rows while standalone rows are unconstrained.
alter table guest_detail_submissions
  drop constraint if exists guest_detail_submissions_booking_id_key;

create unique index if not exists uq_guest_submissions_booking
  on guest_detail_submissions (booking_id)
  where booking_id is not null;

-- ── A token may point at a submission instead of a booking ────────────────
-- trip_access_tokens was built for the trip portal, where a booking always
-- exists. A guest-details token now references the submission directly, which is
-- the thing it actually grants access to.
alter table trip_access_tokens
  alter column booking_id drop not null;

alter table trip_access_tokens
  add column if not exists submission_id uuid references guest_detail_submissions(id) on delete cascade;

create index if not exists idx_trip_tokens_submission
  on trip_access_tokens (submission_id)
  where submission_id is not null;

-- A token must grant access to exactly one thing. Without this, a row with both
-- columns null would be an orphan that redeems to nothing.
alter table trip_access_tokens
  drop constraint if exists trip_access_tokens_target_check;

alter table trip_access_tokens
  add constraint trip_access_tokens_target_check
  check (booking_id is not null or submission_id is not null);
