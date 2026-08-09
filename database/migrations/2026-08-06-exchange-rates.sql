create table if not exists exchange_rate_snapshots (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  base_currency text not null default 'USD',
  rates jsonb,
  provider_timestamp timestamptz,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  status text not null check (status in ('success', 'failed')),
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references admin_users(id) on delete set null
);

create index if not exists idx_exchange_rate_snapshots_latest_success
  on exchange_rate_snapshots(provider, base_currency, fetched_at desc)
  where status = 'success';

create index if not exists idx_exchange_rate_snapshots_status
  on exchange_rate_snapshots(provider, status, fetched_at desc);

create table if not exists exchange_rate_locks (
  lock_key text primary key,
  owner text not null,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create or replace function exchange_rates_try_lock(p_lock_key text, p_owner text, p_ttl_seconds integer)
returns boolean as $$
declare
  v_rows integer;
begin
  insert into exchange_rate_locks(lock_key, owner, locked_at, expires_at)
  values (p_lock_key, p_owner, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (lock_key) do update
    set owner = excluded.owner,
        locked_at = excluded.locked_at,
        expires_at = excluded.expires_at
    where exchange_rate_locks.expires_at <= now()
       or exchange_rate_locks.owner = p_owner;

  get diagnostics v_rows = row_count;
  return coalesce(v_rows, 0) > 0;
end;
$$ language plpgsql;

create or replace function exchange_rates_release_lock(p_lock_key text, p_owner text)
returns void as $$
begin
  delete from exchange_rate_locks where lock_key = p_lock_key and owner = p_owner;
end;
$$ language plpgsql;

insert into permissions (permission_key, description)
values
  ('exchange_rates.view', 'View exchange-rate cache status.'),
  ('exchange_rates.refresh', 'Manually refresh exchange-rate cache.')
on conflict (permission_key) do update set description = excluded.description;

insert into role_permissions (role, permission_key)
select role, permission_key
from (
  values
    ('super_admin'::user_role, 'exchange_rates.view'),
    ('super_admin'::user_role, 'exchange_rates.refresh'),
    ('admin'::user_role, 'exchange_rates.view'),
    ('admin'::user_role, 'exchange_rates.refresh'),
    ('finance_manager'::user_role, 'exchange_rates.view'),
    ('finance_manager'::user_role, 'exchange_rates.refresh'),
    ('viewer'::user_role, 'exchange_rates.view')
) as grants(role, permission_key)
on conflict (role, permission_key) do nothing;
