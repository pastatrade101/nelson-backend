-- Link an itinerary day to the activities catalogue.
--
-- `itinerary_days.activities` is free text — 75 of 196 days say things like
-- "Game Drives" or "Game Drive, Airport Transfer". Meanwhile the activities
-- table holds real records with a price, duration, badge, best season and
-- photographs, and nothing referenced them. The same gap `accommodation` had
-- before accommodation_id.
--
-- A join table rather than a column, because a day has SEVERAL activities and
-- they have an order. It mirrors how lodge_images and tour_inclusions already
-- work, so the shape is familiar.
--
-- The free-text column STAYS and is untouched. It remains the fallback for the
-- days already written, and for anything that will never be a catalogue entry
-- ("Airport Transfer"). Linking is additive: a day may have neither, either, or
-- both, and the public page renders whichever it has.
--
-- Additive and idempotent.

create table if not exists itinerary_day_activities (
  id uuid primary key default gen_random_uuid(),
  day_id uuid not null references itinerary_days(id) on delete cascade,
  activity_id uuid not null references activities(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),

  -- One link per pair: adding the same activity twice to a day is a mistake,
  -- not a feature.
  unique (day_id, activity_id)
);

create index if not exists idx_day_activities_day on itinerary_day_activities(day_id, sort_order);
create index if not exists idx_day_activities_activity on itinerary_day_activities(activity_id);

comment on table itinerary_day_activities is
  'Which catalogue activities happen on an itinerary day. itinerary_days.activities remains the free-text fallback.';
