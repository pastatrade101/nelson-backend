-- "Reason to exist" fields on tours (founder's task list 2.9, Nov 2026).
--
-- Each itinerary says who it is for, why it runs this many days, when to go,
-- who should choose something else, and which comfort tiers it can be run at.
-- The tour editor edits them and the tour page shows the ones that are filled.
--
-- Additive and idempotent: every column is optional, so existing tours and the
-- current editor keep working before and after this runs.

alter table tours
  add column if not exists target_traveller text,
  add column if not exists duration_rationale text,
  add column if not exists best_season text,
  add column if not exists not_suited_for text,
  add column if not exists comfort_tiers text[] not null default '{}';

comment on column tours.target_traveller is 'Who this itinerary is designed for.';
comment on column tours.duration_rationale is 'Why the trip runs this many days.';
comment on column tours.best_season is 'When to go, in the editor''s words (months or seasons).';
comment on column tours.not_suited_for is 'Who should choose a different itinerary, and why.';
comment on column tours.comfort_tiers is 'Comfort tiers this itinerary can be run at: essential | classic | luxury | ultra_luxury (shown as Classic / Mid-Luxury / Luxury / Ultra Luxury).';

-- Only the four tier keys.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tours_comfort_tiers_valid') then
    alter table tours add constraint tours_comfort_tiers_valid
      check (comfort_tiers <@ array['essential', 'classic', 'luxury', 'ultra_luxury']::text[]);
  end if;
end $$;

-- Let the API see the new columns straight away.
notify pgrst, 'reload schema';
