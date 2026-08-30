-- Bring the property model up to the goldfinch shape.
--
-- Emnel's `lodges` carries about twenty columns; goldfinch's carries fifty, plus
-- child tables for rooms, seasonal rates, highlights and inclusions. That gap is
-- why the property page had nothing to show beyond a description, and why the
-- admin form is a short one.
--
-- ONE DELIBERATE DEPARTURE FROM GOLDFINCH: its enums are UPPERCASE and different
-- — accommodation_level is BUDGET / MID_RANGE / LUXURY / PREMIUM_LUXURY, and
-- lodge_type is SAFARI_LODGE / TENTED_CAMP / … Emnel's existing CHECK constraints
-- allow only essential / classic / luxury / ultra_luxury, which is the vocabulary
-- $lib/tiers, the filter, the nav and the tour budget_tier all share. Copying
-- goldfinch's values would fail those constraints on insert AND undo that shared
-- vocabulary. So the COLUMNS are ported and the VALUES stay Emnel's, in
-- lowercase snake_case like every other enum-ish column here.
--
-- Purely additive: every column is nullable or defaulted, so existing rows and
-- every current query behave exactly as before.
-- Idempotent: safe to run repeatedly on the live database.

-- ── Property detail ────────────────────────────────────────────────────────
alter table lodges
  add column if not exists short_description text,
  add column if not exists country text,
  add column if not exists region text,
  add column if not exists park_area text,
  -- Free text[] rather than an enum: the setting vocabulary is editorial and
  -- grows. Suggested values: inside_national_park, outside_national_park,
  -- conservation_area, private_reserve, beachfront, island, city, countryside,
  -- mountain, remote_wilderness.
  add column if not exists settings text[] not null default '{}',
  add column if not exists recommended_nights integer,
  add column if not exists best_months text[] not null default '{}',
  add column if not exists mobile_hero_image_url text,
  add column if not exists social_image_url text;

-- ── Getting there ──────────────────────────────────────────────────────────
alter table lodges
  add column if not exists google_maps_url text,
  add column if not exists latitude numeric(9, 6),
  add column if not exists longitude numeric(9, 6),
  add column if not exists nearest_airport text,
  add column if not exists transfer_time text,
  add column if not exists distance_airstrip text,
  add column if not exists distance_park_gate text,
  -- all_vehicles | four_by_four_recommended | four_by_four_required |
  -- seasonal_access | fly_in_only
  add column if not exists road_accessibility text,
  add column if not exists fly_in_available boolean,
  add column if not exists transfer_available boolean;

-- ── Who it suits ───────────────────────────────────────────────────────────
alter table lodges
  add column if not exists children_allowed boolean,
  add column if not exists minimum_child_age integer,
  add column if not exists family_friendly boolean,
  add column if not exists honeymoon_friendly boolean,
  -- fully_accessible | partially_accessible | not_accessible | unknown
  add column if not exists accessibility text,
  add column if not exists wheelchair_accessible boolean;

-- ── Practicalities travellers actually ask about ───────────────────────────
alter table lodges
  -- twenty_four_hours | limited_hours | solar_only | generator_backup |
  -- no_reliable_power
  add column if not exists electricity_availability text,
  -- property_wide | common_areas_only | rooms_only | limited | not_available
  add column if not exists wifi_availability text,
  add column if not exists mobile_networks text[] not null default '{}',
  add column if not exists arrival_instructions text,
  add column if not exists traveler_notes text;

-- ── Publishing control ─────────────────────────────────────────────────────
alter table lodges
  -- Rates are commercially sensitive; off unless someone opts in.
  add column if not exists show_rates_publicly boolean not null default false,
  add column if not exists indexable boolean not null default true;

create index if not exists idx_lodges_country_region on lodges(country, region);

-- ── Highlights ─────────────────────────────────────────────────────────────
create table if not exists lodge_highlights (
  id uuid primary key default gen_random_uuid(),
  lodge_id uuid not null references lodges(id) on delete cascade,
  title text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_lodge_highlights_lodge on lodge_highlights(lodge_id, sort_order);

-- ── Rooms, and their photographs ───────────────────────────────────────────
create table if not exists lodge_rooms (
  id uuid primary key default gen_random_uuid(),
  lodge_id uuid not null references lodges(id) on delete cascade,
  name text not null,
  -- standard_room | deluxe_room | superior_room | suite | family_room |
  -- family_suite | safari_tent | luxury_tent | cottage | chalet | villa |
  -- bungalow | honeymoon_suite
  room_type text,
  short_description text,
  max_adults integer,
  max_children integer,
  max_guests integer,
  -- single | twin | double | queen | king | bunk_bed | sofa_bed | extra_bed
  bed_types text[] not null default '{}',
  unit_count integer,
  -- garden | pool | mountain | ocean | beach | river | lake | savannah |
  -- forest | wildlife | city | courtyard
  views text[] not null default '{}',
  amenities text[] not null default '{}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lodge_rooms_lodge on lodge_rooms(lodge_id, sort_order);

drop trigger if exists set_lodge_rooms_updated_at on lodge_rooms;
create trigger set_lodge_rooms_updated_at before update on lodge_rooms
  for each row execute function set_updated_at();

create table if not exists lodge_room_images (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references lodge_rooms(id) on delete cascade,
  image_url text not null,
  alt_text text,
  caption text,
  sort_order integer not null default 0,
  is_cover boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_lodge_room_images_room on lodge_room_images(room_id, sort_order);

-- ── Seasonal rates ─────────────────────────────────────────────────────────
-- Indicative property rates. A safari quote combines the stay with transport,
-- guiding, park fees and activities, so these are guidance rather than a price.
create table if not exists lodge_seasonal_rates (
  id uuid primary key default gen_random_uuid(),
  lodge_id uuid not null references lodges(id) on delete cascade,
  -- low_season | green_season | shoulder_season | high_season | peak_season |
  -- festive_season
  season_type text not null default 'high_season',
  season_name text,
  valid_from date,
  valid_until date,
  currency text not null default 'USD',
  rack_rate numeric(12, 2),
  net_rate numeric(12, 2),
  single_rate numeric(12, 2),
  double_rate numeric(12, 2),
  triple_rate numeric(12, 2),
  child_rate numeric(12, 2),
  single_supplement numeric(12, 2),
  -- per_person | per_person_sharing | per_room | per_unit | per_night
  pricing_basis text not null default 'per_person_sharing',
  -- room_only | bed_and_breakfast | half_board | full_board | all_inclusive |
  -- full_board_plus_activities
  meal_plan text not null default 'full_board',
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lodge_rates_lodge on lodge_seasonal_rates(lodge_id, sort_order);

drop trigger if exists set_lodge_rates_updated_at on lodge_seasonal_rates;
create trigger set_lodge_rates_updated_at before update on lodge_seasonal_rates
  for each row execute function set_updated_at();

-- ── What the nightly rate covers ───────────────────────────────────────────
create table if not exists lodge_inclusions (
  id uuid primary key default gen_random_uuid(),
  lodge_id uuid not null references lodges(id) on delete cascade,
  title text not null,
  is_included boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_lodge_inclusions_lodge on lodge_inclusions(lodge_id, sort_order);

-- ── Permissions ────────────────────────────────────────────────────────────
-- One key covers the whole property-detail surface; the screens are edited
-- together and splitting them would be permission theatre.
insert into permissions (permission_key, description)
select permission_key, replace(permission_key, '.', ' ')
from unnest(array['lodge_details.view','lodge_details.update']) as permission_key
on conflict (permission_key) do update set description = excluded.description;

-- Roles with rows in role_permissions have their in-memory list REPLACED at boot
-- (see services/permissions.service.ts), so every role that should reach these
-- needs its grants here — code defaults alone would not survive hydration.
insert into role_permissions (role, permission_key)
select role, permission_key
from (values ('super_admin'::user_role), ('admin'::user_role), ('content_manager'::user_role)) as roles(role)
cross join (select permission_key from permissions where permission_key like 'lodge_details.%') as granted
on conflict do nothing;

insert into role_permissions (role, permission_key)
select role, 'lodge_details.view'
from (values ('editor'::user_role), ('viewer'::user_role)) as roles(role)
on conflict do nothing;

-- ── Seed country from the linked destination ───────────────────────────────
-- Cheap and safe: the destination already knows its country, so a property need
-- not be re-typed. Guarded to rows with nothing set.
update lodges l
set country = d.country
from destinations d
where l.destination_id = d.id
  and l.deleted_at is null
  and coalesce(btrim(l.country), '') = ''
  and coalesce(btrim(d.country), '') <> '';

-- NOT ported from goldfinch, deliberately: the supplier and contracting tables
-- (accommodation_suppliers, lodge_suppliers — commission, contract dates,
-- payment and cancellation terms, inspections, internal notes) and the
-- relationship tables (lodge_alternatives, lodge_tours, lodge_destinations).
-- Those are an internal operations system rather than anything a traveller sees,
-- and they deserve their own decision rather than arriving as a side effect of a
-- form port.
