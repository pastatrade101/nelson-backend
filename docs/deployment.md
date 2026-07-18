# Deployment & Operations

## Where it runs

- **Server:** VPS, SSH `makutano@vmi2680790`. App lives in `~/app`.
- **Orchestration:** Docker Compose. The `docker-compose.yml` in `~/app` is a
  **shared, multi-app** file (it also runs other projects), so the Goldfinch
  services use explicit container names rather than generic `backend`/`frontend`.

| Role | Container name | Image |
|------|----------------|-------|
| Backend (API) | `tour-site-api-server` | `app-tour-site-api-server` |
| Frontend (web) | `tour-site-web-server` | `app-tour-site-web-server` |

- **Storage:** Supabase Storage bucket **`goldfinch-media`** (public). Auto-created
  on first upload; created manually once if missing.
- **Root files not in git:** `database/`, `docker-compose.yml`, and `Makefile` live
  at the project root (which is not a git repo) and are maintained directly on the
  server. Code changes ship via the two git repos; these root files are synced manually.

## Deploy a change

The images build from source, so update the source first, then rebuild:

```bash
# on the server, in the repos used by docker-compose build contexts
git -C <backend-dir>  pull
git -C <frontend-dir> pull

cd ~/app
make deploy            # == docker compose up -d --build
```

> `make deploy` rebuilds via the shared compose file. Use `make help` to see all
> shortcuts. If `make` isn't installed: `sudo apt install make`, or run the raw
> `docker compose up -d --build`.

### Makefile shortcuts (run from `~/app`)

```
make deploy            Rebuild & (re)start the site
make db-pipeline       Apply schema + migrations + seed
make backfill          Generate thumbnails for old images (one-time)
make ps                Show running containers
make logs-backend      Tail backend logs
make logs-frontend     Tail frontend logs
make restart           Restart backend + frontend
```

## Environment variables

Secrets live **only** in the backend `.env` on the server — never in code or git.
See [environment.md](environment.md) for the full reference. After changing `.env`,
redeploy (`make deploy`) so the container picks it up.

`JWT_SECRET` must be a strong, unique value in production (the app refuses to boot
in `production` with the default). It signs both admin and trip-portal sessions.

## Database migrations

Migrations are plain SQL in `database/migrations/` (dated filenames). The DB is
Supabase, and schema + migrations + seed are applied through one backend command:

```bash
npm run db:pipeline
```

The command requires a raw Postgres connection string in `.env`:

```bash
SUPABASE_DB_URL=postgresql://...
```

Migrations are written idempotently (`create table if not exists`, `add column if
not exists`) so re-running is safe. See [database.md](database.md) for the list and
order.

## Running backend scripts

One-off jobs run **inside** the API container (so they use its `.env`):

```bash
docker exec -it tour-site-api-server npm run <script>:prod
```

| Script | Purpose |
|--------|---------|
| `db:pipeline:prod` | Apply `schema.sql`, dated migrations, and `seed.sql` using `SUPABASE_DB_URL` |
| `backfill:thumbnails:prod` | Generate webp thumbnails for previously uploaded images (run once after the media-thumbnails migration) |
| `email:test:prod <to>` | Send a test email to verify the configured provider |
| `ai:nightly:prod` | Nightly maintenance (analytics + AI data retention purges) |

## Email (Resend or SMTP)

Transactional email powers: the trip-portal **“Email link”** action, the
self-service **“Email me a link”** flow, and **new-booking notifications**.
It is **provider-agnostic** and **fails safe** — if nothing is configured, sends
are skipped and the rest of the app keeps working (admins can still copy links).

Pick **one** provider by setting env in the backend `.env`:

### Option A — Resend (recommended)

1. Create an account at **resend.com** (free tier: ~3,000 emails/month).
2. **Domains → Add domain** for the domain in your `EMAIL_FROM` (e.g.
   `goldfinch.makutano.co.tz`). Add the **SPF + DKIM** DNS records it shows and
   wait until the domain is **Verified** (required, or sends are rejected).
3. **API Keys → Create API key.**
4. In `.env`:
   ```
   RESEND_API_KEY=re_your_real_key
   EMAIL_FROM="Goldfinch Adventures <noreply@goldfinch.makutano.co.tz>"
   SPECIALIST_EMAIL=you@goldfinch.makutano.co.tz   # where new-booking alerts go
   ```

> **Quick test without a domain:** set `EMAIL_FROM="Goldfinch Adventures
> <onboarding@resend.dev>"`. Resend's shared test sender only delivers to *your
> own Resend account email* — use it just to confirm the pipeline, then switch to
> your verified domain for real customers.

### Option B — SMTP (your domain mailbox)

```
SMTP_HOST=mail.makutano.co.tz
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@goldfinch.makutano.co.tz
SMTP_PASS=••••••
EMAIL_FROM="Goldfinch Adventures <noreply@goldfinch.makutano.co.tz>"
SPECIALIST_EMAIL=you@goldfinch.makutano.co.tz
```

### Verify it works

```bash
docker exec -it tour-site-api-server npm run email:test:prod someone@example.com
```
A `403 ... domain is not verified` error means the provider is reachable but
`EMAIL_FROM`'s domain still needs verifying (Option A, step 2).

## Routine deploy checklist

1. `git pull` the backend and/or frontend repos on the server.
2. Update `.env` if new variables were added.
3. Apply DB schema/migrations/seed: `make db-pipeline`.
4. `make deploy`.
5. Smoke-test the affected feature.
