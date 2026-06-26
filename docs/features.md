# Features

A feature-by-feature guide to how the major pieces work and where they live.

## Public site

The marketing site: home, tours + tour detail, destinations, lodges, activities,
blog, comparisons (`/compare`), FAQs, safety guide, contact, and the lead funnels
(**Booking request** and **Plan My Trip**). SSR via `adapter-node`; also an
installable **PWA** (manifest + service worker, offline page, "Install app"
button in the navbar).

## Admin CMS (`/admin/*`)

A full content-management UI for every content type (tours, destinations, lodges,
blog, gallery, testimonials, FAQs, comparisons, homepage, branding, …) plus
bookings, payments, messages, users/roles, analytics, audit logs, and AI tools.
Admin auth is a JWT Bearer token with role/permission gating.

## Media library & thumbnails

- **Upload** (`/admin/media`, or inline via the picker) stores the file in Supabase
  Storage and—when it's an image—generates a **600px webp thumbnail** with `sharp`
  (`media_library.thumbnail_url`). Non-fatal: if thumbnailing fails the upload
  still succeeds.
- **`MediaPicker`** (`lib/components/admin/MediaPicker.svelte`) is the reusable
  image control used across all admin forms: a visual library grid (with search),
  **Upload**, and **Paste URL**. Rendered into a `<body>` portal so it centers
  correctly.
- **Public cards** load the thumbnail automatically: backend reads attach
  `<column>_thumbnail`, and `thumbUrl()` (frontend) prefers it, falling back to
  the original.
- **Backfill** old images once: `npm run backfill:thumbnails:prod`.

## Trip portal (magic link)

Password-less, secure access for a traveller to **one** booking — view itinerary,
payments/balance, and message their specialist. Frontend: `/trip` (portal) and
`/trip/<token>` (one-time exchange).

**Security model**
- Link token = 256-bit random; only its **SHA-256 hash** is stored
  (`trip_access_tokens`), with `expires_at` (120 days) and revoke-on-regenerate.
- Opening a valid link mints an **httpOnly, `secure`, `sameSite=lax`,
  scope-checked JWT cookie** (`gf_trip`, 14 days), then the token is stripped from
  the URL. Trip tokens can't access admin routes and vice-versa.
- The customer view excludes all internal fields (`admin_notes`, `assigned_to`,
  `lead_context`, ids). Endpoints are rate-limited; portal pages are `noindex`.

**Getting the link to the traveller**
- **Admin:** on a booking, **Copy trip link** or **Email link**.
- **Self-service:** `/trip` → "Email me a link" (enumeration-safe — always returns
  a generic confirmation). Requires email to be configured.

Migration: `2026-06-25-trip-portal.sql`.

## Email

Provider-agnostic transactional email (`services/email.service.ts`): uses **Resend**
(`RESEND_API_KEY`) or **SMTP** (`nodemailer`) if configured, else no-ops safely.
Powers the trip-link emails and **new-booking notifications** to
`SPECIALIST_EMAIL`. Setup + testing: [deployment.md](deployment.md#email-resend-or-smtp).

## Leads & CRM

Both the **Booking request** and **Plan My Trip** forms write to
`booking_requests` (with a structured `lead_context` brief). On submit the backend
also: sends a specialist notification email (if configured) and best-effort syncs
the lead to **HubSpot**. Comparison CTAs pass a `?topic=…` that the Plan My Trip
form pre-fills and records on the lead. Anti-spam: honeypot + rate limiting +
duplicate-submit guard.

## Analytics

Two layers, both optional and privacy-aware:
- **First-party:** PII-free events in `analytics_events`; `trackEvent()` on the
  frontend; a dashboard at `/admin/analytics`. Consent banner gates GA4; events
  purge after `ANALYTICS_RETENTION_DAYS`.
- **GA4:** when `PUBLIC_GA4_MEASUREMENT_ID` (gtag) and the GA4 Data API service
  account are set, traffic is shown in the dashboard. Charts use Chart.js.

## AI travel advisor

A Claude-powered advisor widget with strict cost/abuse controls: per-session and
per-IP caps, daily/monthly budget with **auto-degrade to Haiku**, prompt caching,
optional Cloudflare **Turnstile**, and a **pgvector semantic cache** to reuse
answers. Admin views: `/admin/ai-conversations`, `/admin/ai-usage`. Disabled
cleanly if `ANTHROPIC_API_KEY` is unset (or via the `AI_ENABLED` flag / admin
settings toggle).

## Branding & theming

The admin **Branding** page recolors the whole site live by writing brand colors
into CSS variables (`--c-*`). Includes **dark mode** (toggle + remembered) for
both the public site and admin, implemented via `.dark` overrides of those
variables.
