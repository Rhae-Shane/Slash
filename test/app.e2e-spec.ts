import request from 'supertest';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { prisma } from '../src/db';
import type { RedisClient } from '../src/redis';

const LONG_URL = 'https://example.com/path?q=1';
const apiKeyHeader = { 'x-api-key': config.apiKey };

describe('URL Shortener (e2e)', () => {
  let app: ReturnType<typeof createApp>['app'];
  let redis: RedisClient;
  const createdCodes: string[] = [];

  beforeAll(async () => {
    await prisma.$connect();
    const ctx = createApp();
    app = ctx.app;
    redis = ctx.redis;
  }, 30_000);

  afterEach(async () => {
    while (createdCodes.length > 0) {
      const shortCode = createdCodes.pop()!;
      await prisma.url.deleteMany({ where: { shortCode } });
      await redis.del(`url:${shortCode}`);
    }
  }, 30_000);

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  }, 30_000);

  async function createUrl(body: Record<string, unknown> = { longUrl: LONG_URL }) {
    const res = await request(app)
      .post('/api/v1/urls')
      .set(apiKeyHeader)
      .send(body)
      .expect(201);
    createdCodes.push(res.body.shortCode);
    return res;
  }

  async function waitForClicks(
    shortCode: string,
    minClicks: number,
    attempts = 20,
  ): Promise<number> {
    for (let i = 0; i < attempts; i++) {
      const row = await prisma.url.findUnique({ where: { shortCode } });
      const clicks = Number(row?.clickCount ?? 0);
      if (clicks >= minClicks) {
        return clicks;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const row = await prisma.url.findUnique({ where: { shortCode } });
    return Number(row?.clickCount ?? 0);
  }

  describe('POST /api/v1/urls', () => {
    it('rejects missing API key', async () => {
      const res = await request(app)
        .post('/api/v1/urls')
        .send({ longUrl: LONG_URL })
        .expect(401);

      expect(res.body.statusCode).toBe(401);
    });

    it('rejects invalid create payload', async () => {
      const res = await request(app)
        .post('/api/v1/urls')
        .set(apiKeyHeader)
        .send({ longUrl: 'not-a-url' })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
      expect(res.body.requestId).toBeDefined();
    });

    it('rejects non-http(s) URLs', async () => {
      await request(app)
        .post('/api/v1/urls')
        .set(apiKeyHeader)
        .send({ longUrl: 'ftp://example.com/file' })
        .expect(400);
    });

    it('rejects expiresAt in the past', async () => {
      await request(app)
        .post('/api/v1/urls')
        .set(apiKeyHeader)
        .send({
          longUrl: LONG_URL,
          expiresAt: '2020-01-01T00:00:00.000Z',
        })
        .expect(400);
    });

    it('rejects unknown fields (strict schema)', async () => {
      await request(app)
        .post('/api/v1/urls')
        .set(apiKeyHeader)
        .send({ longUrl: LONG_URL, foo: 'bar' })
        .expect(400);
    });

    it('creates a short URL', async () => {
      const res = await createUrl();

      expect(res.body).toMatchObject({
        longUrl: LONG_URL,
        isActive: true,
        clickCount: 0,
        expiresAt: null,
      });
      expect(res.body.shortCode).toMatch(/^[0-9A-Za-z]{7}$/);
      expect(res.body.shortUrl).toContain(res.body.shortCode);
      expect(res.body.id).toBeDefined();
      expect(res.body.createdAt).toBeDefined();
    });

    it('creates a short URL with future expiresAt', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const res = await createUrl({ longUrl: LONG_URL, expiresAt });

      expect(new Date(res.body.expiresAt).toISOString()).toBe(
        new Date(expiresAt).toISOString(),
      );
    });
  });

  describe('GET /api/v1/urls/:shortCode', () => {
    it('returns metadata for an active URL', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      const res = await request(app)
        .get(`/api/v1/urls/${shortCode}`)
        .expect(200);

      expect(res.body).toMatchObject({
        shortCode,
        longUrl: LONG_URL,
        isActive: true,
      });
    });

    it('returns 404 for unknown short code', async () => {
      await request(app).get('/api/v1/urls/zzzzzzz').expect(404);
    });

    it('rejects invalid shortCode param', async () => {
      await request(app).get('/api/v1/urls/bad_code!').expect(400);
    });
  });

  describe('GET /:shortCode (redirect)', () => {
    it('redirects to the long URL', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      const res = await request(app).get(`/${shortCode}`).expect(302);

      expect(res.headers.location).toBe(LONG_URL);
    });

    it('increments click count asynchronously', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      await request(app).get(`/${shortCode}`).expect(302);
      const clicks = await waitForClicks(shortCode, 1);
      expect(clicks).toBeGreaterThanOrEqual(1);
    });

    it('serves redirect from Redis cache on subsequent hits', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      const cachedBefore = await redis.get(`url:${shortCode}`);
      expect(cachedBefore).toBe(LONG_URL);

      await request(app).get(`/${shortCode}`).expect(302);
      await request(app).get(`/${shortCode}`).expect(302);

      const cachedAfter = await redis.get(`url:${shortCode}`);
      expect(cachedAfter).toBe(LONG_URL);
    });

    it('returns 404 for unknown short code', async () => {
      await request(app).get('/zzzzzzz').expect(404);
    });
  });

  describe('DELETE /api/v1/urls/:shortCode', () => {
    it('rejects missing API key', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      await request(app).delete(`/api/v1/urls/${shortCode}`).expect(401);
    });

    it('soft-deactivates and invalidates Redis', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      await request(app).get(`/${shortCode}`).expect(302);
      expect(await redis.get(`url:${shortCode}`)).toBe(LONG_URL);

      const res = await request(app)
        .delete(`/api/v1/urls/${shortCode}`)
        .set(apiKeyHeader)
        .expect(200);

      expect(res.body.isActive).toBe(false);
      expect(await redis.get(`url:${shortCode}`)).toBeNull();

      await request(app).get(`/${shortCode}`).expect(404);
      await request(app).get(`/api/v1/urls/${shortCode}`).expect(404);
    });

    it('returns 404 when already inactive', async () => {
      const created = await createUrl();
      const { shortCode } = created.body;

      await request(app)
        .delete(`/api/v1/urls/${shortCode}`)
        .set(apiKeyHeader)
        .expect(200);
      await request(app)
        .delete(`/api/v1/urls/${shortCode}`)
        .set(apiKeyHeader)
        .expect(404);
    });
  });

  describe('expiration', () => {
    it('returns 404 for expired URLs on metadata and redirect', async () => {
      const created = await createUrl({
        longUrl: LONG_URL,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      const { shortCode } = created.body;

      await prisma.url.update({
        where: { shortCode },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await redis.del(`url:${shortCode}`);

      const meta = await request(app).get(`/api/v1/urls/${shortCode}`).expect(404);
      expect(meta.body.message).toMatch(/expired/i);

      const redirect = await request(app).get(`/${shortCode}`).expect(404);
      expect(redirect.body.message).toMatch(/expired/i);
    });
  });

  describe('health', () => {
    it('GET /health returns ok', async () => {
      const res = await request(app).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
    });

    it('GET /ready checks database and redis', async () => {
      const res = await request(app).get('/ready').expect(200);
      expect(res.body).toMatchObject({
        status: 'ready',
        checks: { database: 'up', redis: 'up' },
      });
    });
  });

  describe('API docs (Stoplight)', () => {
    it('GET /api-docs serves Stoplight Elements', async () => {
      const res = await request(app).get('/api-docs').expect(200);
      expect(res.text).toContain('@stoplight/elements');
      expect(res.text).toContain('elements-api');
      expect(res.text).toContain('User Routes');
    });

    it('GET /api/openapi is generated from Zod', async () => {
      const res = await request(app).get('/api/openapi').expect(200);
      expect(res.body.openapi).toBe('3.0.0');
      expect(res.body.info.title).toMatch(/URL Shortener/i);
      expect(res.body.components.securitySchemes.ApiKeyAuth).toBeDefined();
      expect(res.body.paths['/api/v1/urls'].post.security).toEqual([
        { ApiKeyAuth: [] },
      ]);
    });
  });

  describe('errors', () => {
    it('rejects invalid JSON body', async () => {
      const res = await request(app)
        .post('/api/v1/urls')
        .set(apiKeyHeader)
        .set('Content-Type', 'application/json')
        .send('{"longUrl":')
        .expect(400);

      expect(res.body.message).toMatch(/invalid json/i);
    });
  });
});
