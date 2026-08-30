-- Optional traveller-proof metadata for the existing gallery system.
--
-- Existing gallery rows remain valid because both columns are nullable. The
-- API validates the Month YYYY format and keeps guest quotes short; the
-- database constraints also protect records written outside the API.
-- Idempotent: safe to run repeatedly in the Supabase SQL editor.

alter table public.gallery_images
  add column if not exists travel_month text,
  add column if not exists guest_quote text;

comment on column public.gallery_images.travel_month is
  'Optional traveller-facing month and year, for example August 2026.';
comment on column public.gallery_images.guest_quote is
  'Optional short guest quote associated with this real safari image or video.';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'gallery_images_travel_month_format'
      and conrelid = 'public.gallery_images'::regclass
  ) then
    alter table public.gallery_images
      add constraint gallery_images_travel_month_format
      check (
        travel_month is null
        or btrim(travel_month) ~* '^(January|February|March|April|May|June|July|August|September|October|November|December)[[:space:]]+[0-9]{4}$'
      );
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'gallery_images_guest_quote_length'
      and conrelid = 'public.gallery_images'::regclass
  ) then
    alter table public.gallery_images
      add constraint gallery_images_guest_quote_length
      check (guest_quote is null or char_length(guest_quote) <= 180);
  end if;
end
$$;
