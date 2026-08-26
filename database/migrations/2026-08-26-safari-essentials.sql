-- Safari Essentials — the evergreen guide hub at /safari-essentials.
--
-- These are the planning articles the master site map calls "Tanzania Safari
-- Essentials": Best Time to Visit, Safari Cost, Tanzania vs Kenya, and so on.
-- They are deliberately NOT blog posts. The blog is chronological and news-shaped;
-- these are evergreen, rewritten in place rather than superseded, and they form
-- a topic cluster that links into the itineraries. Keeping them in their own
-- table lets the hub order them editorially (sort_order) instead of by date.
--
-- `country` is what makes the map's principle 2 hold — "Kenya and Rwanda must be
-- addable later without restructuring". A Kenya Safari Essentials hub is a new
-- value in this column, not a schema change.
--
-- Idempotent: safe to run repeatedly on the live database (Supabase SQL editor).

create table if not exists safari_essentials (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  -- One or two lines used on the hub card and as the fallback meta description.
  summary text,
  -- The article body (rich text/HTML, same pipeline as blog content).
  content text,
  hero_image_url text,
  -- Editorial grouping within the hub, e.g. 'Planning', 'Wildlife', 'Practical'.
  topic text,
  -- Scopes the article to a destination country so Kenya/Rwanda hubs need no
  -- restructuring later. Tanzania is the only live destination today.
  country text not null default 'Tanzania',
  meta_title text,
  meta_description text,
  og_image_url text,
  noindex boolean not null default false,
  status publish_status not null default 'draft',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid references admin_users(id) on delete set null,
  updated_by uuid references admin_users(id) on delete set null
);

-- Public page lookup is by slug; the hub reads by country + status and orders
-- by sort_order.
create index if not exists idx_safari_essentials_slug on safari_essentials(slug);
create index if not exists idx_safari_essentials_country_status_sort
  on safari_essentials(country, status, sort_order);

drop trigger if exists set_safari_essentials_updated_at on safari_essentials;
create trigger set_safari_essentials_updated_at before update on safari_essentials
  for each row execute function set_updated_at();

insert into permissions (permission_key, description)
select permission_key, replace(permission_key, '.', ' ')
from unnest(array[
  'safari_essentials.view',
  'safari_essentials.create',
  'safari_essentials.update',
  'safari_essentials.delete',
  'safari_essentials.publish'
]) as permission_key
on conflict (permission_key) do update set description = excluded.description;

-- Roles with rows in role_permissions have their in-memory list REPLACED at boot
-- (see services/permissions.service.ts), so every role that should reach the new
-- screens needs its grants here — code defaults alone would not survive hydration.
insert into role_permissions (role, permission_key)
select role, permission_key
from (values ('super_admin'::user_role), ('admin'::user_role), ('content_manager'::user_role)) as roles(role)
cross join (select permission_key from permissions where permission_key like 'safari_essentials.%') as granted
on conflict do nothing;

insert into role_permissions (role, permission_key)
select role, 'safari_essentials.view'
from (values ('editor'::user_role), ('viewer'::user_role)) as roles(role)
on conflict do nothing;

-- The nine topics the master site map names, seeded as DRAFTS: slug, title and
-- running order only. No body copy is invented here — a draft renders nowhere,
-- stays out of the sitemap and out of the nav, so the hub cannot ship a thin or
-- doorway-style page (principle 9). Each becomes live the moment someone writes
-- it and hits publish.
insert into safari_essentials (slug, title, topic, sort_order, status)
values
  ('best-time-to-visit-tanzania',    'Best Time to Visit Tanzania',    'Planning',   10, 'draft'),
  ('tanzania-safari-cost',           'Tanzania Safari Cost',           'Planning',   20, 'draft'),
  ('how-to-plan-a-tanzania-safari',  'How to Plan a Tanzania Safari',  'Planning',   30, 'draft'),
  ('great-migration-timing',         'Great Migration Timing Guide',   'Wildlife',   40, 'draft'),
  ('tanzania-vs-kenya',              'Tanzania vs Kenya Safari',       'Choosing',   50, 'draft'),
  ('luxury-vs-mid-range',            'Luxury vs Mid-Range Safari',     'Choosing',   60, 'draft'),
  ('tanzania-safari-with-children',  'Tanzania Safari with Children',  'Who it suits', 70, 'draft'),
  ('tanzania-safari-for-couples',    'Tanzania Safari for Couples',    'Who it suits', 80, 'draft'),
  ('what-to-pack',                   'What to Pack for Tanzania',      'Practical',  90, 'draft')
on conflict (slug) do nothing;
