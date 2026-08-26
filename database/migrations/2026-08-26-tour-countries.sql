-- Make the product catalogue country-aware, additively.
--
-- Today a tour's country is only inferable through a single optional
-- destination_id, which means two things are impossible: asking "show me every
-- Kenya trip", and representing a journey that spans Kenya + Tanzania. That is
-- the real blocker to adding a second destination country — not the URL shape.
--
-- An array rather than a scalar, because it answers both questions with one
-- column and no join table: ['Tanzania'] for the current catalogue,
-- ['Kenya','Tanzania'] for an East Africa journey. (safari_essentials keeps a
-- scalar `country` — a guide is written about one country, a trip is not.)
--
-- Nothing here renames or removes anything. Existing rows get the default, so
-- every current query keeps returning exactly what it returns today.
-- Idempotent: safe to run repeatedly on the live database.

alter table tours
  add column if not exists countries text[] not null default '{Tanzania}'::text[];

-- GIN, because every country query is a containment test (`countries @> {Kenya}`).
create index if not exists idx_tours_countries on tours using gin (countries);

-- Backfill from the linked destination, so the column is true rather than merely
-- defaulted. Guarded to rows still sitting at the untouched default: once someone
-- sets a real multi-country value it is never clobbered by a re-run.
update tours t
set countries = array[d.country]
from destinations d
where t.destination_id = d.id
  and d.country is not null
  and d.country <> ''
  and t.countries = '{Tanzania}'::text[]
  and d.country <> 'Tanzania';

-- A quick look at what the catalogue now claims.
--   select unnest(countries) as country, count(*)
--   from tours where deleted_at is null group by 1 order by 2 desc;
