# URL Shortener — Design Document

Standalone Express service (Prisma + PostgreSQL + Upstash Redis + Zod + Stoplight).

---

## 0. Module & function dependency map

### Source layout

```
src/
  index.ts                 # process entry
  app.ts                   # Express app factory + error middleware
  config.ts                # dotenv (.env + .env.local override)
  db.ts                    # PrismaClient singleton
  redis.ts                 # Upstash RedisClient (get / set / del / ping)
  logger.ts                # Pino
  swagger.ts               # Stoplight Elements UI + OpenAPI routes
  openapi/document.ts      # OpenAPI 3.0 built from Zod schemas
  middleware/
    api-key.ts             # x-api-key for POST/DELETE
    request-id.ts          # x-request-id
    rate-limit.ts
  health/health.routes.ts
  urls/
    urls.schema.ts         # Zod request/response schemas (+ OpenAPI metadata)
    urls.service.ts        # business logic
    urls.routes.ts         # HTTP handlers
prisma/
  schema.prisma            # Url model + datasource
  migrations/              # SQL migrations (use DIRECT_URL)
openapi/
  openapi.json             # generated artifact (npm run openapi:generate)
```

### Boot call graph

```
main()  [index.ts]
  │
  ├─► prisma.$connect()                    [db.ts]
  │
  ├─► createApp()                          [app.ts]
  │     │
  │     ├─► new RedisClient()              [redis.ts]  (Upstash REST)
  │     ├─► new UrlsService(redis)         [urls.service.ts]
  │     ├─► mountSwagger()                 [Stoplight + Zod OpenAPI]
  │     ├─► createHealthRouter(redis)
  │     ├─► createUrlsRouter(...)          [api-key on POST/DELETE]
  │     └─► express.json + error middleware
  │
  └─► app.listen(config.port)
        on SIGINT/SIGTERM → redis.quit() + prisma.$disconnect()
```

### HTTP → function map

| Method | Path | Auth | Route handler | Service method | Downstream |
|--------|------|------|---------------|----------------|------------|
| `POST` | `/api/v1/urls` | `x-api-key` | Zod → `create` | `create` | insert → cache → response |
| `GET` | `/api/v1/urls/:shortCode` | public | Zod → `findMetadata` | `findMetadata` | `findActive` → response |
| `DELETE` | `/api/v1/urls/:shortCode` | `x-api-key` | Zod → `deactivate` | `deactivate` | soft-disable → `redis.del` |
| `GET` | `/:shortCode` | public | Zod → `resolveForRedirect` | `resolveForRedirect` | Upstash HIT/MISS → `302` |
| `GET` | `/api-docs` | public | Stoplight Elements UI | — | — |
| `GET` | `/api/openapi` | public | Zod-generated OpenAPI JSON | — | — |

### `UrlsService` private helpers

| Function | Called by | Depends on | Purpose |
|----------|-----------|------------|---------|
| `insertWithUniqueShortCode` | `create` | `randomBase62`, `isUniqueViolation`, Prisma `create` | Base62 + UNIQUE retry ≤ 5 |
| `randomBase62` | `insertWithUniqueShortCode` | `crypto.randomBytes` | 7-char code |
| `isUniqueViolation` | `insertWithUniqueShortCode` | Prisma `P2002` | detect collision |
| `findActive` | `findMetadata`, `resolveForRedirect` | Prisma `findUnique` | 404 if missing / inactive / expired |
| `cacheKey` | cache helpers, `deactivate` | — | `url:{shortCode}` |
| `ttlFor` | `cacheLongUrl` | `expiresAt` | `min(24h, expiresAt−now)` or `null` if ≤ 0 |
| `cacheLongUrl` | `create`, `resolveForRedirect` | `ttlFor`, `redis.set` | skip write if TTL ≤ 0 |
| `incrementClicks` | `resolveForRedirect` (void) | Prisma `clickCount.increment` | not awaited by redirect |
| `toResponse` | create / metadata / deactivate | `config.baseUrl` | JSON DTO |

### Validation (Zod)

| Schema | Used by | Rules |
|--------|---------|-------|
| `createUrlSchema` | `POST /api/v1/urls` | `.strict()`; `longUrl` http(s), max 2048; `expiresAt` ISO + future |
| `shortCodeParamSchema` | GET/DELETE metadata & redirect | Base62, length 1–16 |

OpenAPI is generated from these Zod schemas (`@asteasolutions/zod-to-openapi`). Runtime docs: `buildOpenApiDocument()` in `src/openapi/document.ts`. Artifact: `npm run openapi:generate` → `openapi/openapi.json`.

### Auth

| Header | Required on | Behavior |
|--------|-------------|----------|
| `x-api-key` | `POST /api/v1/urls`, `DELETE /api/v1/urls/:shortCode` | Must match `API_KEY` (timing-safe compare); else `401` |
| `x-request-id` | optional all routes | Echoed; server generates UUID if omitted |

### `RedisClient` methods (Upstash REST)

| Method | Used by | Behavior on failure |
|--------|---------|---------------------|
| `get(key)` | `resolveForRedirect` | returns `null` (cache miss); logs `redis_cache_error` |
| `set(key, value, ttl)` | `cacheLongUrl` | no-op if `ttl ≤ 0`; logs + continues |
| `del(key)` | `deactivate` | logs + continues |
| `ping()` | `/ready` | returns `false`; logs |
| `getFailureCounts()` | ops/debug | per-op counters |

Cache is best-effort; PostgreSQL remains source of truth.

### Cross-module imports

```
index.ts         → app, config, db
app.ts           → errors, redis, swagger, health, urls/*, middleware
db.ts            → @prisma/client
redis.ts         → config, logger (@upstash/redis)
swagger.ts       → openapi/document (Stoplight HTML)
openapi/document → urls.schema (zod-to-openapi)
urls.routes.ts   → api-key, errors, urls.schema, urls.service
urls.service.ts  → config, db, errors, redis, urls.schema
urls.schema.ts   → zod + zod-to-openapi extensions
config.ts        → dotenv (.env then .env.local)
```

### Env

| Variable | Role |
|----------|------|
| `DATABASE_URL` | App queries (Supabase transaction pooler `:6543` + `pgbouncer=true`) |
| `DIRECT_URL` | Prisma migrations (Supabase direct `db.*.supabase.co:5432`) |
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash token |
| `API_KEY` | Shared secret for create/deactivate (min 8 chars) |
| `BASE_URL` | Used to build `shortUrl` in responses |

---

## 1. Architecture

### Create short URL

```
                    ┌──────────────┐
                    │    Client    │
                    └──────┬───────┘
                           │
                 POST /api/v1/urls
                 Header: x-api-key
                           │
                           ▼
                  ┌─────────────────┐
                  │ Express Server  │
                  │                 │
                  │ Validate URL    │
                  │ Generate code   │
                  │ Store mapping   │
                  └───────┬─────────┘
                          │
             ┌────────────┴────────────┐
             ▼                         ▼
      ┌──────────────┐          ┌──────────────┐
      │ PostgreSQL   │          │ Upstash Redis│
      │ (Supabase)   │          │ code → URL   │
      └──────────────┘          └──────────────┘
```

### Redirect

```
GET /aB3xY9k
       │
       ▼
┌──────────────┐
│ API/Redirect │
└──────┬───────┘
       │
       ▼
   Redis lookup
       │
    ┌──┴──┐
   HIT   MISS
    │      │
    │      ▼
    │  PostgreSQL
    │  (is_active? expires_at?)
    │      │
    │      ▼
    │   Redis SET (only if TTL > 0)
    │
    ▼
302 Location: longUrl
       │
       └─► async click_count += 1  (not awaited)
```

### Deactivate (soft-disable)

```
DELETE /api/v1/urls/:shortCode
        │
        ▼
UPDATE urls SET is_active = false
 WHERE short_code = ?
        │
        ▼
DEL url:{shortCode} from Redis
        │
        ▼
200 + URL metadata (isActive: false)
```

When a URL is deactivated, its Redis cache entry is immediately invalidated. This prevents inactive URLs from being served from cache.

---

## 2. API Design

### Create — `POST /api/v1/urls`

**Request**

```json
{
  "longUrl": "https://example.com/very/long/path",
  "expiresAt": "2026-12-31T23:59:59Z"
}
```

| Field | Required | Rules |
|-------|----------|-------|
| `longUrl` | yes | Valid `http`/`https` URL; **maximum 2048 characters** |
| `expiresAt` | no | ISO-8601; see §7 |

**Success `201`**

```json
{
  "id": "uuid",
  "shortCode": "aB3xY9k",
  "shortUrl": "http://localhost:3001/aB3xY9k",
  "longUrl": "https://example.com/very/long/path",
  "createdAt": "...",
  "expiresAt": null,
  "isActive": true,
  "clickCount": 0
}
```

**Errors**

| Status | Condition |
|--------|-----------|
| `400` | Malformed / non-http(s) `longUrl` |
| `400` | `longUrl` exceeds 2048 characters |
| `400` | `expiresAt` invalid or `<= now` |
| `400` | Unexpected body fields |
| `500` | Unique short-code collisions after 5 retries |

### Metadata — `GET /api/v1/urls/:shortCode`

Returns the same JSON shape as create (no redirect). `404` if unknown, inactive, or expired.

### Deactivate — `DELETE /api/v1/urls/:shortCode`

Soft-disables the row and deletes `url:{shortCode}` from Redis. `404` if already inactive or missing.

### Redirect — `GET /:shortCode`

| Status | Meaning |
|--------|---------|
| `302` | `Location: <longUrl>` |
| `404` | Unknown, inactive, or expired |

---

## 3. Database Schema

```sql
CREATE TABLE urls (
    id UUID PRIMARY KEY,
    short_code VARCHAR(16) NOT NULL UNIQUE,
    long_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NULL,
    click_count BIGINT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
```

| Column | Type | Notes |
|--------|------|--------|
| `id` | `UUID` | Primary key |
| `short_code` | `VARCHAR(16)` | Unique public alias |
| `long_url` | `TEXT` | Original URL (app enforces ≤ 2048) |
| `created_at` | `TIMESTAMPTZ` | Default `NOW()` |
| `expires_at` | `TIMESTAMPTZ` | Nullable = never expires |
| `click_count` | `BIGINT` | Default `0` (see §8) |
| `is_active` | `BOOLEAN` | Soft disable; false → 404 on redirect/metadata |

**Indexes:** `UNIQUE(short_code)` already creates a unique index — no separate secondary index needed.

**Why `id` as PK (not `short_code`):** Stable internal identity if aliases rotate, analytics attach, or encoding length changes. `short_code` is the unique business key for redirects.

**Optional later:** `updated_at TIMESTAMPTZ` if URLs are modified often. Not required for this service.

---

## 4. Short-code generation

**Approach:** Random Base62 + UNIQUE constraint + bounded retry.

- Alphabet: `[0-9A-Za-z]` (62 chars)
- Length: **7** → `62^7 ≈ 3.5 trillion` (enough for millions of URLs; 8 chars unnecessary here)

```
Generate 7-char Base62 code
        ↓
INSERT into urls
        ↓
Unique constraint?
   ┌────┴────┐
  No        Yes (23505)
   │          │
 return     retry — up to 5 times
              ↓
            all 5 failed?
              ↓
            log + 500 Internal Server Error
```

The DB unique constraint is the final authority. Do **not** rely on a pre-INSERT `SELECT` existence check (TOCTOU race under concurrency).

### Alternative (not used): ID → Base62

```
DB ID → Base62 encode → shortCode
```

Avoids random collisions but needs ID allocation first; sequential IDs make aliases somewhat predictable.

---

## 5. Upstash Redis cache

Key: `url:{shortCode}` → plain `longUrl` string.  
Client: `@upstash/redis` REST (not ioredis / local Docker Redis).

On cache errors the request continues against Postgres; Pino logs `metric: redis_cache_error` with per-op failure counts.

**Key / value (simple form — chosen for this project):**

```
url:{shortCode} → longUrl
```

(A JSON payload with `expiresAt` is optional; Redis TTL already encodes expiration.)

**TTL rules**

```
if expiresAt is null:
  TTL = 24 hours
else:
  TTL = min(24 hours, expiresAt − now)

if TTL <= 0:
  do not cache
```

| `expiresAt` | Redis TTL |
|-------------|-----------|
| none | 24h |
| 2 hours from now | 2h |
| 3 days from now | 24h |
| already past / ≤ now | **no write** |

**Deactivation:** always `DEL url:{shortCode}` immediately after setting `is_active = false`.

---

## 6. Redirect flow & expiration

```
GET /aB3xY9k
        │
        ▼
      Redis GET
        │
   ┌────┴────┐
  HIT       MISS
   │         │
   │         ▼
   │      PostgreSQL
   │         │
   │    !url / !is_active → 404
   │    expires_at <= now → 404
   │         │
   │         ▼
   │      Redis SET (if TTL > 0)
   │
   ▼
302 Location: longUrl
```

Redis HIT is safe for **expiration** because TTL is capped by `expiresAt` (and expired/near-zero entries are never written). Inactive URLs cannot linger in cache after deactivate because of immediate `DEL` (§1 / §5).

---

## 7. `expiresAt` validation

| Input | Result |
|-------|--------|
| omitted / `null` | never expires |
| `<= now` | `400` |
| invalid ISO string | `400` |
| `> now` | valid; used for DB + Redis TTL |

---

## 8. Click counting

`click_count` is updated asynchronously after the redirect is resolved. The update is **not awaited** by the redirect response, so click counting does not add latency to the critical redirect path.

For a larger deployment, this can later be moved to a queue/event-based analytics pipeline:

```
GET /aB3xY9k
       │
       ├──────────────► Redis / Postgres resolve → 302
       │
       └──────────────► Analytics / event queue
                              │
                              ▼
                         Click processor → PostgreSQL
```

Example event:

```json
{
  "type": "URL_CLICKED",
  "shortCode": "aB3xY9k",
  "timestamp": "...",
  "userAgent": "...",
  "referrer": "..."
}
```

If analytics are not required, `click_count` can be omitted from the core design entirely.

---

## 9. Constants (implementation)

| Constant | Value | Location |
|----------|-------|----------|
| `SHORT_CODE_LENGTH` | `7` | `urls.service.ts` |
| `MAX_GENERATION_ATTEMPTS` | `5` | `urls.service.ts` |
| `MAX_LONG_URL_LENGTH` | `2048` | `urls.service.ts`, `urls.routes.ts` |
| `CACHE_TTL_SECONDS` | `86400` (24h) | `urls.service.ts` |
| Default port | `3001` | `config.ts` / `PORT` |

---

## 10. Error model

| Class | Status | Typical causes |
|-------|--------|----------------|
| `BadRequestError` | 400 | validation failures |
| `UnauthorizedError` | 401 | missing/invalid `x-api-key` on POST/DELETE |
| `NotFoundError` | 404 | missing / inactive / expired |
| `InternalServerError` | 500 | short-code generation exhausted |
| unhandled | 500 | logged; generic message returned |

Mapped in Express error middleware in `app.ts`.

---

## 11. Docs & deploy

| Surface | How |
|---------|-----|
| Stoplight UI | `GET /api-docs` (same Elements UI as Validd) |
| OpenAPI JSON | `GET /api/openapi` — built at runtime from Zod |
| Static artifact | `npm run openapi:generate` → `openapi/openapi.json` |
| Container | `Dockerfile` multi-stage (`node:22-alpine`); run with `--env-file` |
