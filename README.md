# URL Shortener

Standalone Express service (Prisma + PostgreSQL + Upstash Redis).

Design docs:
- Assignment brief (API + schema only): [DESIGN-BRIEF.md](./DESIGN-BRIEF.md)
- Full design: [DESIGN.md](./DESIGN.md)

## Stack

- Express 5
- Prisma 6
- Zod 4 (request + env validation; OpenAPI generated via `@asteasolutions/zod-to-openapi`)
- Pino (structured logging + request IDs)
- express-rate-limit
- Stoplight Elements (API explorer UI)
- PostgreSQL (Supabase)
- Upstash Redis (REST)
- TypeScript 5

## Setup

```bash
cp .env.example .env          # or cp .env.local.example .env.local
npm install
npx prisma migrate deploy
npm run start:dev
```

Set:
- `DATABASE_URL` / `DIRECT_URL` (Supabase pooler + direct)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
- `API_KEY` (required for create + deactivate; min 8 chars)

API: `http://localhost:3001`  
API Explorer: `http://localhost:3001/api-docs`  
OpenAPI JSON: `http://localhost:3001/api/openapi` (Zod-generated; also `npm run openapi:generate`)

## Docker

```bash
docker build -t url-shortener .
docker run --env-file .env -p 3001:3001 url-shortener
```

## API examples

### Create short URL (API key required)

```bash
curl -s -X POST http://localhost:3001/api/v1/urls \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d "{\"longUrl\":\"https://example.com/very/long/path\"}"
```

### Redirect

```bash
curl -i http://localhost:3001/<shortCode>
```

### Metadata (public)

```bash
curl -s http://localhost:3001/api/v1/urls/<shortCode>
```

### Deactivate (API key required)

```bash
curl -s -X DELETE http://localhost:3001/api/v1/urls/<shortCode> \
  -H "x-api-key: $API_KEY"
```

### Health

```bash
curl -s http://localhost:3001/health
curl -s http://localhost:3001/ready
```
