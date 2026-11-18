-- Tour price grid and two-step enquiry (Nelson's developer brief, 16 Nov 2026).
--
-- 1. Pricing options get structured fields, so the tour page can build a grid
--    of comfort level x group size from them:
--      comfort_tier     essential | classic | luxury | ultra_luxury
--                       (shown as Classic / Mid-Luxury / Luxury / Ultra Luxury)
--      travellers_from  first group size the price is for (1, 2, 3, 5)
--      travellers_to    last group size the price is for  (1, 2, 4, 6)
--      lodges           the lodges at this level, shown under the tier heading
--    `price` stays the adult price per person and `child_price` (2026-11-16)
--    the child price per person. Old options (Essential / Signature / Prestige)
--    leave these empty and keep showing as before until they are re-entered.
-- 2. tours.price_note: the one line under "Prices for this safari", e.g.
--    "Per person, sharing, including park fees and the flight to Zanzibar."
--
-- booking_requests.source is plain text with no database check, so the new
-- 'tour_enquiry' source needs no change here; the API validates sources.
--
-- Additive and safe to run more than once. Nothing reads the new columns until
-- the new code is deployed.

alter table tour_price_options
  add column if not exists comfort_tier text,
  add column if not exists travellers_from integer,
  add column if not exists travellers_to integer,
  add column if not exists lodges text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tour_price_options_comfort_tier_valid') then
    alter table tour_price_options add constraint tour_price_options_comfort_tier_valid
      check (comfort_tier is null or comfort_tier in ('essential', 'classic', 'luxury', 'ultra_luxury'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tour_price_options_travellers_valid') then
    alter table tour_price_options add constraint tour_price_options_travellers_valid
      check (
        (travellers_from is null and travellers_to is null)
        or (travellers_from between 1 and 20 and travellers_to between travellers_from and 20)
      );
  end if;
end $$;

create index if not exists tour_price_options_grid_idx
  on tour_price_options (tour_id, comfort_tier, travellers_from)
  where comfort_tier is not null;

comment on column tour_price_options.comfort_tier is 'Grid column: essential | classic | luxury | ultra_luxury (Classic / Mid-Luxury / Luxury / Ultra Luxury). Null = an old-style option.';
comment on column tour_price_options.travellers_from is 'Grid row: first group size this adult price is for (1, 2, 3 or 5).';
comment on column tour_price_options.travellers_to is 'Grid row: last group size this adult price is for (1, 2, 4 or 6).';
comment on column tour_price_options.lodges is 'Lodges at this comfort level, shown under the tier heading.';

alter table tours add column if not exists price_note text;
comment on column tours.price_note is 'One line under "Prices for this safari" on the tour page.';

notify pgrst, 'reload schema';
