-- Market landing pages — the template engine behind /safaris/[slug].
-- One route renders N Google Ads market pages ("Tanzania Safari from Dubai",
-- "…from the UK") straight from this table, so marketing can launch a new market
-- in the admin with no code deploy. `sections` is an ordered array of typed
-- content blocks; the frontend renders the blocks it knows and skips the rest.
-- Idempotent: safe to run repeatedly on the live database (Supabase SQL editor).

create table if not exists market_pages (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  market_code text,
  currency text not null default 'USD',
  hero_eyebrow text,
  hero_title text,
  hero_subtitle text,
  hero_image_url text,
  hero_cta_label text,
  hero_cta_href text,
  sections jsonb not null default '[]'::jsonb,
  featured_tour_ids uuid[] not null default '{}',
  meta_title text,
  meta_description text,
  og_image_url text,
  -- Ads landing pages stay out of the organic index unless marketing opts in.
  noindex boolean not null default true,
  status publish_status not null default 'draft',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_by uuid references admin_users(id) on delete set null,
  updated_by uuid references admin_users(id) on delete set null
);

-- Public page lookup is by slug; the listings (public + admin) read by status
-- and order by sort_order.
create index if not exists idx_market_pages_slug on market_pages(slug);
create index if not exists idx_market_pages_status_sort_order on market_pages(status, sort_order);

drop trigger if exists set_market_pages_updated_at on market_pages;
create trigger set_market_pages_updated_at before update on market_pages for each row execute function set_updated_at();

insert into permissions (permission_key, description)
select permission_key, replace(permission_key, '.', ' ')
from unnest(array['market_pages.view','market_pages.create','market_pages.update','market_pages.delete','market_pages.publish']) as permission_key
on conflict (permission_key) do update set description = excluded.description;

-- Roles with rows in role_permissions have their in-memory list REPLACED at boot
-- (see services/permissions.service.ts), so every role that should reach the new
-- screens needs its grants here — code defaults alone would not survive hydration.
insert into role_permissions (role, permission_key)
select role, permission_key
from (values ('super_admin'::user_role), ('admin'::user_role), ('content_manager'::user_role)) as roles(role)
cross join (select permission_key from permissions where permission_key like 'market_pages.%') as granted
on conflict do nothing;

insert into role_permissions (role, permission_key)
select role, 'market_pages.view'
from (values ('editor'::user_role), ('viewer'::user_role)) as roles(role)
on conflict do nothing;
