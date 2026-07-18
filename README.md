# Goldfinch Tour Website — Backend API

Express + TypeScript API backed by Supabase (PostgreSQL + Storage) for the
Goldfinch Adventures public site, admin CMS, customer trip portal, and AI advisor.

## 📚 Documentation

Full system docs live in **[`docs/`](docs/)**:

- [Architecture](docs/architecture.md) — components, stack, repo layout
- [Deployment & Ops](docs/deployment.md) — server, Makefile, scripts, **email/Resend setup**
- [Environment variables](docs/environment.md) — full reference
- [Database](docs/database.md) — schema + migrations
- [Features](docs/features.md) — trip portal, email, media, analytics, AI, …
- [API reference](docs/api.md) — endpoints & auth

## Stack
- Express 4 + TypeScript (`tsx` in dev, `tsc` build), Node 22
- Supabase (`@supabase/supabase-js`) — Postgres + Storage
- JWT auth (`jsonwebtoken`) + `bcryptjs`; Zod, Helmet, CORS, rate limiting, Morgan
- `sharp` (thumbnails), `nodemailer`/Resend (email), Anthropic Claude (AI)

## Local development
```bash
npm install
cp .env.example .env   # then fill in (see docs/environment.md). Never commit .env
npm run dev            # tsx watch src/server.ts  (default PORT 5000)
npm run build          # tsc -> dist/
npm start              # node dist/server.js
```
Health check: `GET /api/health`.

## Ops scripts
Run inside the container in production: `docker exec -it tour-site-api-server npm run <name>:prod`
```bash
npm run db:pipeline          # apply schema + migrations + seed
npm run backfill:thumbnails   # generate webp thumbnails for old images
npm run email:test <to>       # send a test email via the configured provider
npm run ai:nightly            # analytics + AI data-retention purges
```

## Deploy
Docker Compose on the VPS — see [docs/deployment.md](docs/deployment.md). In short:
`git pull` → `npm run db:pipeline` → `make deploy`.

Secrets (`SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `RESEND_API_KEY`,
`HUBSPOT_ACCESS_TOKEN`, …) are read from env only and never exposed to the frontend.
