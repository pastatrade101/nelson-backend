-- Link each travel style to the safari-style card it is written for.
--
-- The Safari Styles page and the navbar dropdown are built from tour categories,
-- while the copy an editor writes for a style (emotional promise, what they
-- want, concerns, content blocks) lives on travel_styles. Nothing joined the
-- two, so every card opened the tour filter and none of that copy was reachable
-- from it — "Tanzania Family Safaris" existed as both, unconnected.
--
-- With this column the card opens /travel-styles/<slug>, and that page's
-- "Browse itineraries" filters by the linked category. The frontend also
-- matches identical names until a link is set, so this is additive: a style
-- with no link keeps working exactly as before.
--
-- Additive and idempotent.

alter table travel_styles
  add column if not exists category_id uuid references tour_categories(id) on delete set null;

create index if not exists idx_travel_styles_category on travel_styles (category_id) where deleted_at is null;

comment on column travel_styles.category_id is
  'The safari-style card (tour_categories row) this style is written for. The card links to the style page when set.';

-- The styles that already have a matching card. Only fills empty links, so a
-- re-run never overrides a choice made in Admin → Travel Styles.
update travel_styles ts
set category_id = c.id
from (values
  ('tanzania-family-safaris', 'family-safaris'),
  ('honeymoon', 'honeymoon-safaris'),
  ('luxury-travel', 'luxury-tanzania-safaris'),
  ('photography', 'photography-safaris')
) as pair(style_slug, category_slug)
join tour_categories c on c.slug = pair.category_slug and c.deleted_at is null
where ts.slug = pair.style_slug
  and ts.category_id is null
  and ts.deleted_at is null;

notify pgrst, 'reload schema';
