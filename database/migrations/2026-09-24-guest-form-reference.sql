-- Give every guest form a human reference, so the link we send reads properly.
--
-- The link was 43 random characters and nothing else. That is fine for security
-- and awful to send to a guest, who cannot tell what it is or that it is meant
-- for them. The URL now carries their name and a reference code ahead of the
-- token:
--
--   /guest-details/miller-family-emn-gf-000004/K7mQ2xR9vLpN4sT1wY8zAb
--
-- THE DECORATIVE PART IS DECORATIVE. The token is still the only credential and
-- is still checked on every request; the slug is never used to find anything. It
-- could be edited to another family's name and would change nothing, which is
-- exactly the property we want — otherwise guessing a colleague's reference
-- would open their passport data.
--
-- Additive and idempotent.

alter table guest_detail_submissions
  add column if not exists reference text;

comment on column guest_detail_submissions.reference is
  'Human reference shown in the link, e.g. EMN-GF-000004. Mirrors booking_code when a booking exists. Decorative: never used to authorise access.';

-- Unique where set, so two forms cannot claim the same reference, while the
-- rows that predate this stay null rather than blocking the migration.
create unique index if not exists uq_guest_submissions_reference
  on guest_detail_submissions (reference)
  where reference is not null;

-- Sequence behind the minted codes. A sequence rather than max()+1 so two
-- people creating a form at the same moment cannot be handed the same number.
create sequence if not exists guest_form_reference_seq start with 1;

-- Minted by default, so a standalone form always has a reference without the
-- API having to ask for one. A booking-backed form overwrites this with the
-- booking's own code, so the office sees one reference rather than two for the
-- same party.
alter table guest_detail_submissions
  alter column reference set default 'EMN-GF-' || lpad(nextval('guest_form_reference_seq')::text, 6, '0');

-- Backfill: a booking-backed form takes the booking's own code, so the office
-- sees one reference in both places rather than two for the same party.
update guest_detail_submissions g
set reference = b.booking_code
from booking_requests b
where g.booking_id = b.id
  and g.reference is null
  and coalesce(btrim(b.booking_code), '') <> '';

-- Anything still without one (standalone forms created before this) gets a
-- minted code so every existing link can be reissued in the new pretty form.
update guest_detail_submissions
set reference = 'EMN-GF-' || lpad(nextval('guest_form_reference_seq')::text, 6, '0')
where reference is null;
