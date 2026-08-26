-- Give travel styles the same content-block model the market landing pages use.
--
-- A style page today is a fixed shape: promise, description, two string arrays.
-- Anything richer — how the trip actually runs, which camps suit it, when to go,
-- what it costs, the questions couples or families actually ask — has nowhere to
-- live, so the pages read thin next to the market pages.
--
-- `sections` is an ordered array of typed blocks, exactly as market_pages.sections
-- works, and the SAME renderer components draw both. That is deliberate: the
-- alternative was a second block system with its own editor and its own bugs.
-- Editors gain the richness by filling in forms; nothing needs a new column each
-- time the editorial shape changes.
--
-- Purely additive. Existing styles get an empty array and render exactly as they
-- render today until someone adds a block.
-- Idempotent: safe to run repeatedly on the live database.

alter table travel_styles
  add column if not exists sections jsonb not null default '[]'::jsonb;

-- Blocks are read whole, per page; no per-key querying, so no GIN index is
-- warranted. The lookup that matters is still by slug.
create index if not exists idx_travel_styles_slug on travel_styles(slug);
create index if not exists idx_travel_styles_status_sort on travel_styles(status, sort_order);
