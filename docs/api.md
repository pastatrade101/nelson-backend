# API Reference

Base URL: `${PUBLIC_API_URL}` (e.g. `https://api.../api`). All routes are mounted
under `/api/*` in `backend/src/app.ts`.

## Conventions

**Response envelope** (every endpoint):
```jsonc
{ "success": true,  "message": "…", "data": { /* ... */ } }
{ "success": false, "message": "…", "errors": [ /* ... */ ] }   // on error
```

**Auth**
| Audience | How |
|----------|-----|
| Admin | `Authorization: Bearer <jwt>` → `authenticate` + `requirePermission('<resource.action>')` |
| Trip portal | httpOnly `gf_trip` cookie (sent automatically; client uses `credentials: 'include'`) |
| Public | none (rate-limited) |

**Standard CRUD** (most content resources, via `supabase-helpers`):
```
GET    /api/<resource>            list (?search, ?status, ?page, ?limit, filters)
GET    /api/<resource>/:id|:slug  one
POST   /api/<resource>            create        (admin)
PUT    /api/<resource>/:id        update        (admin)
DELETE /api/<resource>/:id        soft-delete   (admin)
```
Reads are generally public; writes require the matching permission.

## Resource groups

Content (CRUD as above): `tours`, `tour-inclusions`, `tour-exclusions`,
`tour-images`, `itineraries`, `available-dates`, `pricing-options`, `categories`,
`destinations`, `countries`, `lodges`, `activities`, `trip-points`,
`safety-topics`, `travel-styles`, `comparisons`, `blog`, `blog-categories`,
`gallery`, `media`, `testimonials`, `faqs`, `homepage`, `settings`.

## Key non-CRUD endpoints

### Auth — `/api/auth`
| Method | Path | Notes |
|--------|------|-------|
| POST | `/auth/login` | Admin login → `{ token, user }` |
| POST | `/auth/logout` | |
| GET | `/auth/me` | Current admin (Bearer) |

### Bookings & leads — `/api/bookings`, `/api/contact`
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/bookings` | public | Create a lead (Booking / Plan My Trip). Honeypot + rate-limited + dedup |
| GET | `/bookings`, `/bookings/:id`, `/bookings/code/:code` | admin | |
| PUT | `/bookings/:id/status` `/assign` `/notes` `/:id` | admin | |
| POST | `/contact` | public | Contact-form message |

### Trip portal — `/api/trip`
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/trip/request-access` | public | `{ email }` → emails a link. Generic response (enumeration-safe). Rate-limited |
| POST | `/trip/session` | public | `{ token }` → sets `gf_trip` cookie, returns trip view. Rate-limited |
| GET | `/trip/me` | trip cookie | Customer-safe trip view |
| POST | `/trip/message` | trip cookie | `{ message }` → contact_messages. Rate-limited |
| POST | `/trip/logout` | — | Clears the cookie |
| POST | `/trip/admin/links` | admin (`bookings.update`) | `{ booking_id, send_email? }` → `{ url, expiresAt, emailed? }` |

### Media upload — `/api/upload`
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/upload/image` | admin (`media.upload`) | multipart `image` → uploads + generates thumbnail, inserts `media_library` |
| POST | `/upload/lottie` | admin (`media.upload`) | |
| DELETE | `/upload/image` | admin (`media.delete`) | `{ path }` |

### AI advisor — `/api/ai`
Chat + conversation endpoints behind `ai-guard` (session cookie, Turnstile when
configured, per-session/IP caps and budget limits).

### Analytics — `/api/analytics`, `/api/public`
| Method | Path | Auth | Notes |
|--------|------|------|-------|
| POST | `/analytics/events` | public | First-party PII-free event. Rate-limited (`analyticsEventLimiter`) |
| GET | `/analytics/overview` `/leads` `/funnel` `/timeseries` `/traffic` `/integrations` | admin | Dashboard data |
| GET | `/dashboard/*` | admin | Admin home metrics |

### Other
- `/api/payments` — booking payments (admin).
- `/api/hubspot` — CRM helpers.
- `/api/settings` — site settings / feature flags.

## Rate limiting

Defined in `middleware/rate-limit.middleware.ts`: `publicFormLimiter` (lead/contact
forms), `tripAccessLimiter` (trip token exchange + messages), `analyticsEventLimiter`,
plus the AI guard's own per-session/IP limiters.
