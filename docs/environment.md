# Environment Variables

Secrets belong in the **backend `.env`** (server-side only). Frontend values are
limited to `PUBLIC_*` (anything else never reaches the browser). Templates:
`backend/.env.example` and `frontend/.env.example`.

Validation happens in `backend/src/config/env.ts` (Zod). In `production` the app
**refuses to boot** unless `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` are set and
`JWT_SECRET` is changed from the default.

## Backend

### Core

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `5000` | API port |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `FRONTEND_URL` | `http://localhost:5173` | Comma-separated allowed CORS origins; also the base for generated links (trip portal). Trailing slashes stripped |
| `SUPABASE_URL` | — | **Required in prod** |
| `SUPABASE_SERVICE_ROLE_KEY` | — | **Required in prod**. Full DB/storage access — never expose |
| `SUPABASE_STORAGE_BUCKET` | `goldfinch-media` | Public media bucket |
| `SUPABASE_DB_URL` | — | Raw Postgres connection string used by `npm run db:pipeline`; not used by the running API |
| `JWT_SECRET` | dev placeholder | **Must change in prod** (≥16 chars). Signs admin + trip sessions |
| `JWT_EXPIRES_IN` | `7d` | Admin token lifetime |

### Email (transactional) — see [deployment.md](deployment.md#email-resend-or-smtp)

| Variable | Default | Notes |
|----------|---------|-------|
| `EMAIL_FROM` | Goldfinch `<onboarding@resend.dev>` | Must be a verified sender for real delivery |
| `RESEND_API_KEY` | — | Set this to use Resend (recommended) |
| `SMTP_HOST` | — | Set this (and below) to use SMTP instead |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for port 465 |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP auth |
| `SPECIALIST_EMAIL` | — | Inbox for new-booking notifications (blank = skip) |

> If neither `RESEND_API_KEY` nor `SMTP_HOST` is set, email sends are skipped (no errors).

### Integrations (all optional — features degrade gracefully)

| Variable | Notes |
|----------|-------|
| `ANTHROPIC_API_KEY` | AI travel advisor. Blank → advisor disabled |
| `HUBSPOT_ACCESS_TOKEN`, `HUBSPOT_PORTAL_ID` | CRM lead sync (best-effort) |
| `GA4_PROPERTY_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY` | GA4 Data API (traffic in the analytics dashboard). Keep `GOOGLE_PRIVATE_KEY` as a single double-quoted line with literal `\n` |
| `TURNSTILE_SECRET_KEY` | Cloudflare Turnstile (AI abuse protection). When set, it's enforced |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN` | Reserved for WhatsApp notifications |

### Tuning / retention

| Variable | Default | Notes |
|----------|---------|-------|
| `ANALYTICS_RETENTION_DAYS` | `180` | Purge `analytics_events` older than this (nightly) |
| `AI_DATA_RETENTION_DAYS` | `90` | Purge anonymous AI conversations (nightly) |

### AI advisor budget & models

| Variable | Default |
|----------|---------|
| `AI_ENABLED` | `true` |
| `AI_DAILY_BUDGET_USD` / `AI_MONTHLY_BUDGET_USD` | `5` / `100` |
| `AI_MAX_MESSAGES_PER_SESSION` | `15` |
| `AI_MAX_MESSAGES_PER_IP_PER_DAY` | `30` (weak/CGNAT signal) |
| `AI_MAX_INPUT_TOKENS` / `AI_MAX_OUTPUT_TOKENS` | `8000` / `700` |
| `AI_USE_PROMPT_CACHING` / `AI_PROMPT_CACHE_TTL` | `true` / `1h` |
| `AI_DEGRADE_AT_BUDGET_FRACTION` | `0.8` (step down to Haiku) |
| `ANTHROPIC_SIMPLE_MODEL` | `claude-haiku-4-5-20251001` |
| `ANTHROPIC_REASONING_MODEL` | `claude-sonnet-4-6` |
| `ANTHROPIC_VERSION` | `2023-06-01` |
| `AI_EMBEDDING_PROVIDER` / `_MODEL` / `_API_KEY` / `_DIMENSIONS` | — / — / — / `1536` |
| `AI_SEMANTIC_CACHE_THRESHOLD` | `0.92` |

## Frontend (`PUBLIC_*` only)

| Variable | Default | Notes |
|----------|---------|-------|
| `PUBLIC_API_URL` | `http://localhost:5000/api` | Backend base URL (incl. `/api`). Blank → same-domain `/api` |
| `PUBLIC_SITE_URL` | `http://localhost:5173` | Canonical URLs, OG tags, sitemap, robots |
| `PUBLIC_GA4_MEASUREMENT_ID` | — | `G-XXXXXXXXXX`; loads gtag (needs consent banner for EU) |
| `PUBLIC_SUPABASE_IMG_TRANSFORM` | — | `true` to resize Supabase images via the render API (paid Supabase feature). Unsplash always sized; thumbnails are generated server-side regardless |
