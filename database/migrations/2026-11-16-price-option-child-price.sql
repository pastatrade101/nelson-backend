-- Price per child on a tour's pricing option (client request, Nov 2026).
--
-- Each tour is now one page per route, sold at several comfort levels. Its
-- pricing options are those levels (Classic, Mid-Luxury, Luxury): the option's
-- `price` is the price per adult, and this column holds the price per child for
-- the same level. Null means the child rate is given on request.
--
-- Safe to run more than once. The running API reads price options with `*`,
-- so it serves the column as soon as it exists; nothing breaks before then.

alter table tour_price_options
  add column if not exists child_price numeric(12, 2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tour_price_options_child_price_positive') then
    alter table tour_price_options add constraint tour_price_options_child_price_positive
      check (child_price is null or child_price >= 0);
  end if;
end $$;

comment on column tour_price_options.child_price is 'Price per child for this comfort level; null = on request. `price` is the price per adult.';

-- PostgREST caches the schema; reload it so the API sees the new column now.
notify pgrst, 'reload schema';
