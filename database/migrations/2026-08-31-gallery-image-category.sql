-- Give a gallery photograph a category — what it is OF.
--
-- The table already links a photograph to a destination and a tour, but those
-- say where it was taken and which trip it belongs to, not what is in the frame.
-- A lion on the Serengeti and a tent on the Serengeti share a destination and
-- belong in different sections, so the existing links cannot do this grouping.
--
-- Plain text with no CHECK constraint, deliberately: the vocabulary is editorial
-- and expected to grow, and a CHECK would turn "add one more category" into a
-- migration plus a deploy. The list is enforced in the API by the zod enum in
-- src/schemas/gallery.schema.ts, mirrored on the frontend in
-- $lib/galleryCategories.ts. Add a value to BOTH of those.
--
-- Allowed values:
--   wildlife | landscape | safari_experience | accommodation | culture |
--   family | food_and_dining | beach | guide_and_team | vehicle |
--   destination | aerial | guest_experience
--
-- Purely additive and idempotent: the column is nullable with no default, so
-- existing rows read as uncategorised and every current query is unaffected.

alter table gallery_images
  add column if not exists category text;

comment on column gallery_images.category is
  'What the photograph is of. See $lib/galleryCategories.ts for the vocabulary.';

-- Supports the public gallery filtering by category, and the admin listing
-- filtering within a status. Partial: uncategorised rows are the ones we never
-- look up by this column.
create index if not exists idx_gallery_images_category
  on gallery_images (category)
  where category is not null;
