-- Collect passport and traveller details for a confirmed booking, through a
-- private link the office sends to the guest.
--
-- SENSITIVITY: these tables hold passport numbers, dates of birth, nationality
-- and medical notes. Nothing here is ever exposed on a public endpoint. The
-- guest reaches their own submission only by presenting a valid, unexpired,
-- unrevoked token; the office reads it through the authenticated admin API
-- behind the `guest_details.view` permission.
--
-- Purely additive and idempotent.

-- ── Let one booking carry more than one kind of private link ───────────────
-- trip_access_tokens already implements exactly the mechanism this feature
-- needs: a 32-byte random token stored only as a sha256 hash, an expiry, a
-- revocation column, and last-used tracking. Rather than build a second token
-- system, the table gains a purpose so a guest-details link and a trip-portal
-- link can exist for the same booking without revoking one another.
alter table trip_access_tokens
  add column if not exists purpose text not null default 'trip';

comment on column trip_access_tokens.purpose is
  'trip = the trip portal magic link; guest_details = the passport/traveller form.';

create index if not exists idx_trip_tokens_booking_purpose
  on trip_access_tokens (booking_id, purpose)
  where revoked_at is null;

-- ── One submission per booking ────────────────────────────────────────────
create table if not exists guest_detail_submissions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references booking_requests(id) on delete cascade,

  -- Matching information, so the office can tie the form to a reservation even
  -- if the guest was sent the link by a colleague.
  booking_reference text,
  lead_email text,

  -- Travel window and flights.
  arrival_date date,
  departure_date date,
  arrival_flight text,
  departure_flight text,

  -- Emergency contact, held once for the party rather than per traveller.
  emergency_name text,
  emergency_relationship text,
  emergency_phone text,
  emergency_email text,

  consent_given boolean not null default false,
  submitted_at timestamptz,

  -- The office locks a submission once permits and tickets have been issued,
  -- after which the guest's link becomes read-only. Until then they may return
  -- and correct a passport number or add a late traveller.
  locked_at timestamptz,
  locked_by uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One submission per booking; the guest edits it rather than filing another.
  unique (booking_id)
);

create index if not exists idx_guest_submissions_booking on guest_detail_submissions(booking_id);

drop trigger if exists set_guest_submissions_updated_at on guest_detail_submissions;
create trigger set_guest_submissions_updated_at before update on guest_detail_submissions
  for each row execute function set_updated_at();

-- ── One row per traveller ─────────────────────────────────────────────────
create table if not exists guest_details (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references guest_detail_submissions(id) on delete cascade,

  -- Exactly as printed in the passport. Airlines and park authorities reject
  -- permits whose names do not match, which is why the form says so too.
  full_name text not null,
  nationality text,
  date_of_birth date,
  -- male | female | other — free text so it is never a barrier to submitting.
  gender text,

  passport_number text,
  passport_country text,
  passport_expiry date,

  -- Object key inside the PRIVATE documents bucket, never a public URL. The
  -- admin API mints a short-lived signed URL on demand; see upload.service.ts.
  passport_copy_path text,

  dietary text,
  medical text,
  notes text,

  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_guest_details_submission on guest_details(submission_id, sort_order);

drop trigger if exists set_guest_details_updated_at on guest_details;
create trigger set_guest_details_updated_at before update on guest_details
  for each row execute function set_updated_at();

-- ── Permissions ───────────────────────────────────────────────────────────
-- Reading passport data is a narrower privilege than editing a booking, so it
-- gets its own key rather than riding on bookings.update.
insert into permissions (permission_key, description)
select permission_key, replace(permission_key, '.', ' ')
from unnest(array['guest_details.view','guest_details.manage']) as permission_key
on conflict (permission_key) do update set description = excluded.description;

-- Roles with rows in role_permissions have their in-memory list REPLACED at
-- boot (services/permissions.service.ts), so every role that should reach these
-- needs its grant here — code defaults alone would not survive hydration.
insert into role_permissions (role, permission_key)
select role, permission_key
from (values ('super_admin'::user_role), ('admin'::user_role)) as roles(role)
cross join (select permission_key from permissions where permission_key like 'guest_details.%') as granted
on conflict do nothing;

-- Consultants can read the details they need to book, but not issue or revoke
-- the private links.
insert into role_permissions (role, permission_key)
select role, 'guest_details.view'
from (values ('content_manager'::user_role), ('editor'::user_role)) as roles(role)
on conflict do nothing;
