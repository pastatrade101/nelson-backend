-- Link each itinerary day to a real property, and give properties a gallery.
--
-- Today `itinerary_days.accommodation` is free text — "Escarpment Luxury Lodge
-- Serengeti" is a string, not a record — so a day cannot show what the lodge
-- looks like. And a lodge has only two image columns, so even linked there would
-- be nothing to show a row of.
--
-- Both mirror the goldfinch shape deliberately, down to the column names, so the
-- two codebases stay diffable: `accommodation_id` on the day, `lodge_images` as
-- an ordered child table.
--
-- Free text stays and stays authoritative when no lodge is linked: plenty of days
-- name a property we do not hold a record for, and losing that text would be a
-- regression. The link is additive.
--
-- Idempotent: safe to run repeatedly on the live database.

-- ── The day → property link ────────────────────────────────────────────────
alter table itinerary_days
  add column if not exists accommodation_id uuid;

-- The constraint is named explicitly because the API's embed asks for this
-- relationship BY NAME (lodges!itinerary_days_accommodation_id_fkey). Relying on
-- Postgres's default naming would work today and break silently the day someone
-- recreates it differently — and a failed embed 500s the whole tour detail.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'itinerary_days_accommodation_id_fkey') then
    alter table itinerary_days
      add constraint itinerary_days_accommodation_id_fkey
      foreign key (accommodation_id) references lodges(id) on delete set null;
  end if;
end $$;

create index if not exists idx_itinerary_days_accommodation_id
  on itinerary_days(accommodation_id);

-- ── A property's gallery ───────────────────────────────────────────────────
create table if not exists lodge_images (
  id uuid primary key default gen_random_uuid(),
  lodge_id uuid not null references lodges(id) on delete cascade,
  image_url text not null,
  alt_text text,
  caption text,
  -- Editorial order; the itinerary day shows the first four.
  sort_order integer not null default 0,
  -- Marks the one used where a single image is needed.
  is_cover boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lodge_images_lodge_sort
  on lodge_images(lodge_id, sort_order);

drop trigger if exists set_lodge_images_updated_at on lodge_images;
create trigger set_lodge_images_updated_at before update on lodge_images
  for each row execute function set_updated_at();

insert into permissions (permission_key, description)
select permission_key, replace(permission_key, '.', ' ')
from unnest(array['lodge_images.view','lodge_images.create','lodge_images.update','lodge_images.delete']) as permission_key
on conflict (permission_key) do update set description = excluded.description;

-- Roles with rows in role_permissions have their in-memory list REPLACED at boot
-- (see services/permissions.service.ts), so every role that should reach these
-- needs its grants here — code defaults alone would not survive hydration.
insert into role_permissions (role, permission_key)
select role, permission_key
from (values ('super_admin'::user_role), ('admin'::user_role), ('content_manager'::user_role)) as roles(role)
cross join (select permission_key from permissions where permission_key like 'lodge_images.%') as granted
on conflict do nothing;

insert into role_permissions (role, permission_key)
select role, 'lodge_images.view'
from (values ('editor'::user_role), ('viewer'::user_role)) as roles(role)
on conflict do nothing;

-- ── Seed each lodge's gallery from the images it already has ───────────────
-- A lodge's existing hero and card images become its first gallery entries, so
-- linked days show something immediately rather than waiting for a manual
-- upload. Guarded on the lodge having no gallery yet, so a re-run cannot
-- duplicate rows or disturb an edited gallery.
insert into lodge_images (lodge_id, image_url, sort_order, is_cover)
select l.id, l.hero_image_url, 0, true
from lodges l
where l.deleted_at is null
  and coalesce(btrim(l.hero_image_url), '') <> ''
  and not exists (select 1 from lodge_images li where li.lodge_id = l.id);

insert into lodge_images (lodge_id, image_url, sort_order, is_cover)
select l.id, l.image_url, 1, false
from lodges l
where l.deleted_at is null
  and coalesce(btrim(l.image_url), '') <> ''
  and l.image_url is distinct from l.hero_image_url
  and not exists (select 1 from lodge_images li where li.lodge_id = l.id and li.image_url = l.image_url);

-- ── Link days to lodges where the free text names one unambiguously ────────
-- Exact, case-insensitive name match only, and only where exactly one lodge
-- matches. Fuzzy matching would silently attach the wrong property to a day,
-- which is worse than leaving the text as it is.
update itinerary_days d
set accommodation_id = m.lodge_id
from (
  select d2.id as day_id, min(l.id::text)::uuid as lodge_id
  from itinerary_days d2
  join lodges l
    on lower(btrim(l.name)) = lower(btrim(d2.accommodation))
   and l.deleted_at is null
  where d2.accommodation_id is null
    and coalesce(btrim(d2.accommodation), '') <> ''
  group by d2.id
  having count(*) = 1
) m
where d.id = m.day_id;

-- How many days ended up linked:
--   select count(*) filter (where accommodation_id is not null) as linked,
--          count(*) filter (where accommodation_id is null
--                             and coalesce(btrim(accommodation),'') <> '') as text_only
--   from itinerary_days;
