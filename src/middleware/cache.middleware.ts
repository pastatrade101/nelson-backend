import type { NextFunction, Request, Response } from 'express';

/**
 * A short-lived, in-process cache for public catalogue reads.
 *
 * WHY IT LIVES HERE AND NOT IN CADDY OR THE BROWSER
 * The metered resource is Supabase egress, and that is spent on the last hop —
 * this process talking to PostgREST. A cache in front of the site (Caddy, a CDN,
 * the visitor's browser) would spare our own bandwidth, which is not capped, and
 * still let every SSR render re-query Supabase. Sitting here, in front of the
 * controllers, is the only place a hit actually avoids a Supabase request.
 *
 * It is deliberately small and dumb: an in-memory Map with a TTL. No Redis, no
 * new container. The catalogue is read constantly and written a few times a day
 * by one admin, so even sixty seconds collapses the repeat traffic that matters.
 *
 * SAFETY — this is a SHARED cache, so the rules below exist to make it
 * impossible for one person's response to reach another:
 *
 *   1. GET only. Nothing with a side effect is ever cached.
 *   2. Any request carrying credentials BYPASSES the cache completely — it is
 *      neither read from nor written to. Admin responses vary by user and
 *      permission, and a single cached admin payload served to an anonymous
 *      visitor would be a data leak.
 *   3. An explicit ALLOWLIST of public catalogue prefixes, never a denylist. A
 *      private route added later is therefore uncached by default rather than
 *      cached by accident.
 *   4. Only 200 responses are stored, so an error is never replayed.
 *   5. Any write to /api/* clears everything. Writes are rare, and a blunt flush
 *      is far easier to reason about than per-table invalidation — the admin
 *      sees their own edit immediately rather than up to a minute later.
 */

type Entry = { body: unknown; expires: number };

const store = new Map<string, Entry>();

/** Bounded so a crawler hitting endless query strings cannot grow it forever. */
const MAX_ENTRIES = 500;

/**
 * Seconds to hold a public read. 60 is a deliberate compromise: long enough to
 * absorb a burst of renders, short enough that an editor who publishes a change
 * sees it almost at once — and any admin write flushes the cache outright, so
 * their own edits are visible immediately regardless. Set to 0 to disable.
 *
 * Not prefixed PUBLIC_: that prefix means browser-exposed in the SvelteKit app,
 * and this is a backend-only value.
 */
const TTL_MS = Math.max(0, Number(process.env.API_CACHE_TTL_SECONDS ?? 60)) * 1000;

/**
 * Public, read-only catalogue routes. These are the ones the public site pulls
 * on every server-rendered page, which is exactly where the egress goes.
 *
 * Deliberately absent: auth, ai, users, roles, permissions, audit-logs,
 * analytics, dashboard, settings, media, upload, import, bookings, quotations,
 * trip, payments, contact, whatsapp, hubspot and currencies — each is either
 * private, per-user, transactional, or a write path.
 */
const CACHEABLE = [
  '/api/tours',
  '/api/destinations',
  '/api/lodges',
  '/api/lodge-images',
  '/api/activities',
  '/api/trip-points',
  '/api/safety-topics',
  '/api/travel-styles',
  '/api/categories',
  '/api/comparisons',
  '/api/blog',
  '/api/blog-categories',
  '/api/safari-essentials',
  '/api/gallery',
  '/api/testimonials',
  '/api/specialists',
  '/api/faqs',
  '/api/homepage',
  '/api/market-pages',
  '/api/available-dates',
  '/api/pricing-options',
  '/api/tour-inclusions',
  '/api/tour-exclusions',
  '/api/tour-images',
  '/api/itineraries',
  '/api/departures',
  '/api/branding',
  '/api/public'
];

/** Counters, surfaced on /api/health so the effect is measurable in production. */
export const cacheStats = { hits: 0, misses: 0, bypassed: 0, stored: 0, flushes: 0 };

/**
 * True when the request carries a credential this API would actually act on.
 * Such a request is served fresh and its response is never stored — rule 2.
 *
 * The test is deliberately EXACTLY what auth.middleware.ts reads: an
 * `Authorization: Bearer` header, and nothing else. This API has no cookie
 * session — there is no cookie-parser and nothing reads req.cookies — so a
 * cookie carries no identity here.
 *
 * Treating any cookie as a credential (the obvious defensive guess) would have
 * made this cache useless in production: the SvelteKit proxy forwards the
 * visitor's cookies on server-side fetches, and almost every visitor has one
 * from analytics or the currency picker, so virtually every render would have
 * bypassed. Verified against the running API before narrowing this.
 */
const isAuthenticated = (req: Request): boolean =>
  typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');

const isCacheable = (req: Request): boolean =>
  req.method === 'GET' && CACHEABLE.some((p) => req.path === p || req.path.startsWith(`${p}/`));

/** Drops everything. Called after any write so an admin sees their own edit at once. */
export const flushPublicCache = (): void => {
  if (store.size) cacheStats.flushes += 1;
  store.clear();
};

export const publicCache = (req: Request, res: Response, next: NextFunction): void => {
  // A write invalidates the whole catalogue, then carries on to the controller.
  if (req.method !== 'GET' && req.path.startsWith('/api/')) {
    flushPublicCache();
    return next();
  }

  if (TTL_MS <= 0 || !isCacheable(req)) return next();

  if (isAuthenticated(req)) {
    cacheStats.bypassed += 1;
    return next();
  }

  const key = req.originalUrl;
  const hit = store.get(key);

  if (hit && hit.expires > Date.now()) {
    cacheStats.hits += 1;
    res.setHeader('X-Cache', 'HIT');
    res.json(hit.body);
    return;
  }
  if (hit) store.delete(key); // expired

  cacheStats.misses += 1;
  res.setHeader('X-Cache', 'MISS');

  // Capture the controller's payload on its way out.
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode === 200) {
      if (store.size >= MAX_ENTRIES) {
        // Oldest first: Map preserves insertion order, so this is a cheap FIFO.
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { body, expires: Date.now() + TTL_MS });
      cacheStats.stored += 1;
    }
    return originalJson(body);
  }) as Response['json'];

  next();
};

/**
 * Lets a shared cache in front of us reuse a response too, without letting a
 * browser hold a stale copy: max-age=0 forces the browser to revalidate, while
 * s-maxage applies only to shared caches. Applied to the same allowlist.
 */
export const publicCacheHeaders = (req: Request, res: Response, next: NextFunction): void => {
  if (TTL_MS > 0 && isCacheable(req) && !isAuthenticated(req)) {
    const seconds = Math.round(TTL_MS / 1000);
    res.setHeader(
      'Cache-Control',
      `public, max-age=0, s-maxage=${seconds}, stale-while-revalidate=${seconds * 5}`
    );
  } else if (req.path.startsWith('/api/')) {
    // Everything else is private by default — never let a shared cache hold it.
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
};
