# URL Shortener — Design Brief

Simplified URL shortener: take a long URL, generate a short unique alias, redirect visits to the original URL.

---

## 1. API Design

### 1.1 Creating a short URL

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/urls` |

**Request body**

| Parameter | Required | Type | Description |
|-----------|----------|------|-------------|
| `longUrl` | yes | string | Destination URL (`http` or `https`, max 2048 chars) |
| `expiresAt` | no | string (ISO-8601) | Optional expiry time; must be in the future |

```json
{
  "longUrl": "https://example.com/very/long/path",
  "expiresAt": "2026-12-31T23:59:59.000Z"
}
```

**Success response — `201 Created`**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "shortCode": "aB3xY9k",
  "shortUrl": "http://localhost:3001/aB3xY9k",
  "longUrl": "https://example.com/very/long/path",
  "createdAt": "2026-09-23T06:18:51.309Z",
  "expiresAt": "2026-12-31T23:59:59.000Z",
  "isActive": true,
  "clickCount": 0
}
```

| Field | Meaning |
|-------|---------|
| `shortCode` | Unique public alias |
| `shortUrl` | Full short link clients can share |
| `longUrl` | Original URL that was shortened |

**Errors:** `400` invalid body; `401` if API key is required and missing/invalid.

---

### 1.2 Retrieving / redirecting from a short URL

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/:shortCode` |
| **Request body** | none |

**Example:** `GET /aB3xY9k`

**Success response — `302 Found`**

| Header | Value |
|--------|--------|
| `Location` | Original `longUrl` (e.g. `https://example.com/very/long/path`) |

The client (browser) follows `Location` to the long URL. No JSON body on success.

**Error response — `404 Not Found`**

Returned when the short code is unknown, inactive, or expired:

```json
{
  "statusCode": 404,
  "message": "Short URL not found",
  "requestId": "7c9e6679-7425-40de-944b-e07fc1f90ae7"
}
```

---

## 2. Database Schema

Table: `urls`

```sql
CREATE TABLE urls (
    id          UUID PRIMARY KEY,
    short_code  VARCHAR(16) NOT NULL UNIQUE,
    long_url    TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NULL,
    click_count BIGINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
```

| Column | Data type | Notes |
|--------|-----------|--------|
| `id` | `UUID` | **Primary key** |
| `short_code` | `VARCHAR(16)` | Unique public alias used in `GET /:shortCode` |
| `long_url` | `TEXT` | Original URL |
| `created_at` | `TIMESTAMPTZ` | When the row was created |
| `expires_at` | `TIMESTAMPTZ` | Optional; `NULL` = never expires |
| `click_count` | `BIGINT` | Redirect counter (default `0`) |
| `is_active` | `BOOLEAN` | Soft disable; `false` → treat as not found |

**Index:** `UNIQUE (short_code)` for fast, conflict-safe lookups on redirect.

### Primary key: why `id` (not `short_code`)?

We use **`id` (UUID) as the primary key** because:

1. **Stable internal identity** — the row keeps one ID forever, even if the public alias were ever rotated or regenerated.
2. **Separation of concerns** — users type `short_code`; the system joins analytics and future relations on `id`.
3. **`short_code` stays the business key** — it is `UNIQUE` and is what redirect resolves, but it is not the PK so public-facing strings are not tied to internal identity.

In short: **PK = `id` for permanence; `short_code` = unique alias for redirects.**

---

*Diagrams for the video / whiteboard: [docs/DIAGRAMS.md](./docs/DIAGRAMS.md) (Images 2 + 3 cover this brief).*

*Full implementation notes (cache, auth, edge cases): see [DESIGN.md](./DESIGN.md).*
