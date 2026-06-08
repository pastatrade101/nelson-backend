# Goldfinch Tour Website — Backend API

Express + TypeScript API backed by Supabase (PostgreSQL) for the Goldfinch Adventures CMS and public website.

## Stack
- Express 4 + TypeScript (`tsx` in dev, `tsc` build)
- Supabase (`@supabase/supabase-js`)
- JWT auth (`jsonwebtoken`) + `bcryptjs`
- Zod validation, Helmet, CORS, rate limiting, Morgan

## Scripts
```bash
npm install
npm run dev     # tsx watch src/server.ts
npm run build   # tsc -> dist/
npm start       # node dist/server.js
```

## Environment variables
Copy `.env.example` to `.env` and fill in. **Never commit `.env`.**

| Variable | Purpose |
|---|---|
| `PORT` | API port (default 4000) |
| `NODE_ENV` | `development` / `production` |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server only) |
| `JWT_SECRET` | Secret for signing admin JWTs |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `HUBSPOT_ACCESS_TOKEN` | (optional) HubSpot CRM sync |
| `HUBSPOT_PORTAL_ID` | (optional) HubSpot portal id |

## Deploy
1. Provision the Postgres schema with `database/schema.sql`, then `database/seed.sql` (kept in the main project repo).
2. Set the environment variables on your host (Render, Railway, Fly, etc.).
3. Build command: `npm install && npm run build`
4. Start command: `npm start`
5. Health check: `GET /api/health`

Secrets (`SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, `HUBSPOT_ACCESS_TOKEN`) are read from environment variables only and are never exposed to the frontend.
