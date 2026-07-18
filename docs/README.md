# Goldfinch Adventures — System Documentation

Documentation for the Goldfinch Adventures platform: a full‑stack East‑Africa
tour website with a public site, an admin CMS, a customer trip portal, and an
AI travel advisor.

> These docs live in the **backend** repo but describe the whole system
> (frontend + backend + database + deployment).

## Contents

| Doc | What's inside |
|-----|----------------|
| [architecture.md](architecture.md) | The big picture — components, tech stack, repo layout, how requests flow |
| [deployment.md](deployment.md) | How to deploy, the server layout, the `Makefile`, running scripts, **email/Resend setup** |
| [environment.md](environment.md) | Every environment variable, what it does, and which are required |
| [database.md](database.md) | Schema overview, key tables, and how to apply migrations |
| [features.md](features.md) | Feature-by-feature guide (trip portal, email, media/thumbnails, analytics, AI, etc.) |
| [api.md](api.md) | REST API surface — endpoint groups and the public/portal/admin split |

## Quick links

- **Deploy a change:** `make deploy` (see [deployment.md](deployment.md))
- **Apply DB schema/migrations/seed:** `npm run db:pipeline` (see [database.md](database.md))
- **Set up email:** [deployment.md → Email](deployment.md#email-resend-or-smtp)
- **Run a backend script:** `docker exec -it tour-site-api-server npm run <script>:prod`

## At a glance

- **Frontend:** SvelteKit 2 + Svelte 5 + Tailwind (SSR via `adapter-node`), also an installable PWA.
- **Backend:** Express + TypeScript, Supabase (PostgreSQL + Storage) as the data layer.
- **AI:** Claude (Anthropic) travel advisor with budget/abuse controls and a semantic cache.
- **Deploy:** Docker Compose on a VPS; two containers (`tour-site-api-server`, `tour-site-web-server`).
