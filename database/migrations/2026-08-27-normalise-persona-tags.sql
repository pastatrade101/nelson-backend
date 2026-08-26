-- Normalise the persona vocabulary so travel styles can actually reach tours.
--
-- `persona_tags` is free text and has drifted: the catalogue carries BOTH
-- `couple` (10 tours) and `couples` (4), `family` (9) and `families` (4),
-- `honeymoon` (6) and `honeymooners` (1). A travel style matches on one exact
-- string, so half the catalogue was invisible to its own style page.
--
-- Only synonyms of the five canonical personas are rewritten — family, couple,
-- honeymoon, group, solo. Everything else is left alone: values like
-- "wildlife enthusiasts" or "Dubai travellers" are not personas, but they are
-- real editorial data and deleting them here would be destroying information to
-- tidy a column.
--
-- Idempotent: the guard means a second run changes nothing.

update tours t
set persona_tags = sub.tags
from (
  select
    id,
    array(
      select distinct case lower(btrim(tag))
        when 'couples' then 'couple'
        when 'families' then 'family'
        when 'honeymooners' then 'honeymoon'
        else btrim(tag)
      end
      from unnest(persona_tags) as tag
      where btrim(tag) <> ''
    ) as tags
  from tours
  where deleted_at is null
) sub
where t.id = sub.id
  and t.persona_tags is distinct from sub.tags;

-- The Honeymoon style pointed at `couple`, so it inherited the couples list
-- rather than the six trips actually tagged for honeymoons. `honeymoon` is now
-- part of the vocabulary, so point it at itself.
update travel_styles
set persona = 'honeymoon'
where slug = 'honeymoon'
  and persona is distinct from 'honeymoon';

-- NOT changed here, deliberately: `luxury-travel` and `photography` have no
-- persona and are left with none. They describe the KIND of trip, not who is
-- travelling, so forcing them onto this axis would conflate two taxonomies.
-- Their proper home is a tour category — and both `luxury-tanzania-safaris` and
-- `photography-safaris` exist with zero tours assigned, which is an editorial
-- decision rather than a migration.

-- What the catalogue claims afterwards:
--   select unnest(persona_tags) as persona, count(*)
--   from tours where deleted_at is null group by 1 order by 2 desc;
