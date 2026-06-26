# Architecture

## Components

```
                         ┌──────────────────────────┐
   Public visitors  ───▶ │  Frontend (SvelteKit SSR) │
   Travellers       ───▶ │  + PWA  (web-server)      │
   Admin staff      ───▶ │                           │
                         └────────────┬──────────────┘
                                      │  HTTPS  /api/*  (credentials: cookies + Bearer)
                                      ▼
                         ┌──────────────────────────┐
                         │  Backend (Express + TS)   │
                         │  (api-server)             │
                         └───┬───────────┬───────┬───┘
                             │           │       │
                  Supabase   │   Anthropic│   Resend / SMTP, HubSpot, GA4
               (Postgres +   │   (Claude) │   (email, CRM, analytics)
                Storage)     ▼            ▼
```

- The **frontend** renders the public marketing site, the admin CMS (`/admin/*`),
  and the customer **trip portal** (`/trip`). It calls the backend over `/api/*`.
- The **backend** is the only thing that holds secrets and talks to Supabase with
  the service-role key. It exposes a REST API split into public, trip-session,
  and admin (authenticated) endpoints.
- **Supabase** provides PostgreSQL (all data) and Storage (uploaded media +
  generated thumbnails, bucket `goldfinch-media`).

## Tech stack

| Layer | Tech |
|-------|------|
| Frontend | SvelteKit 2, Svelte 5, Tailwind CSS 3, Vite 8, `@sveltejs/adapter-node`, Chart.js (admin), PWA (manifest + service worker) |
| Backend | Node 22, Express 4, TypeScript 5, Zod (validation), `jsonwebtoken`, `express-rate-limit`, `helmet`, `cors` |
| Data | Supabase: PostgreSQL + Storage (`@supabase/supabase-js`) |
| Images | `sharp` (server-side thumbnails) |
| Email | `resend` HTTP API **or** SMTP via `nodemailer` (pluggable) |
| AI | Anthropic Claude (advisor) + pgvector semantic cache |
| Analytics | First-party event store (Postgres) + GA4 Data API |
| CRM | HubSpot (best-effort lead sync) |

## Repository layout

Two independent git repos (the project root itself is **not** a git repo):

- **Frontend** — `github.com/pastatrade101/tour-site-frontend.git`
- **Backend** — `github.com/pastatrade101/tour-site-bckend.git`

The shared `database/`, `docker-compose.yml`, and `Makefile` live at the project
root and are **managed manually on the server** (not committed to either repo).

### Backend (`backend/src/`)

| Folder | Responsibility |
|--------|----------------|
| `config/` | `env.ts` (validated env), `supabase.ts` (service-role client) |
| `routes/` | Express routers, one per resource; mounted in `app.ts` |
| `controllers/` | Request handlers (thin; delegate to services/helpers) |
| `services/` | Business logic — email, trip portal, notifications, AI, HubSpot, GA4, upload, etc. |
| `middleware/` | `auth` (admin JWT), `trip-auth` (portal cookie), `permission`, `rate-limit`, `ai-guard`, validation, error handler |
| `schemas/` | Zod request schemas |
| `jobs/` | Scheduled jobs (e.g. `ai-nightly.ts` — retention purges) |
| `scripts/` | One-off ops scripts (`backfill-thumbnails`, `email-test`) |
| `utils/` | `api-response` (`sendSuccess`/`sendError`/`AppError`), `supabase-helpers` (generic list/get/create/update), `async-handler`, `query` |
| `data/`, `prompts/`, `types/` | Static data, AI prompts, shared TS types |

### Frontend (`frontend/src/`)

| Folder | Responsibility |
|--------|----------------|
| `routes/` | Pages: public site (`/`, `/tours`, `/compare`, …), `/trip` portal, `/admin/*` CMS |
| `lib/components/public/` | Public UI (cards, hero, forms, navbar, footer, portal pieces) |
| `lib/components/admin/` | Admin UI (forms, tables, `MediaPicker`, charts) |
| `lib/api/client.ts` | Typed API client (`api.*`); always sends `credentials: 'include'` |
| `lib/` | Stores + helpers: `img.ts` (`imgUrl`/`thumbUrl`), `theme.ts`, `consent.ts`, `analytics.ts`, `pwa.ts`, `settings.ts` |

## Auth model (three audiences)

| Audience | Mechanism | Notes |
|----------|-----------|-------|
| Admin | JWT **Bearer** token (localStorage) → `authenticate` + `requirePermission` | Role/permission gated |
| Traveller (trip portal) | **httpOnly cookie** JWT, `scope:'trip'`, bound to one booking | Minted by opening a magic link |
| Public | none | Rate-limited public endpoints |

The two token types are scope-isolated: a trip token has no role/permissions
(can't hit admin routes) and admin routes ignore the trip cookie.

## Request flow example — a trip magic link

1. Admin clicks **Email link** on a booking → `POST /api/trip/admin/links` (admin JWT).
2. Backend creates a 256-bit token, stores its **SHA-256 hash** + expiry, emails the link.
3. Traveller opens `/trip/<token>` → `POST /api/trip/session` → backend verifies the
   hash, sets an httpOnly `gf_trip` cookie, returns the customer-safe trip view.
4. Browser is redirected to `/trip` (token stripped from the URL); subsequent
   `GET /api/trip/me` reads the cookie.

See [features.md](features.md) for the full feature set.
