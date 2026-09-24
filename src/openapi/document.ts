import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';
import {
  createUrlSchema,
  errorResponseSchema,
  healthResponseSchema,
  readyResponseSchema,
  shortCodeParamSchema,
  urlResponseSchema,
} from '../urls/urls.schema';

const API_KEY_HEADER = 'x-api-key';
const REQUEST_ID_HEADER = 'x-request-id';

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: API_KEY_HEADER,
    description: 'API key required for create and deactivate endpoints',
  });

  const requestIdParam = {
    name: REQUEST_ID_HEADER,
    in: 'header' as const,
    required: false,
    description:
      'Optional client-supplied request ID for log correlation. If omitted, the server generates a UUID.',
    schema: { type: 'string' as const, format: 'uuid' },
  };

  const errorContent = {
    'application/json': { schema: errorResponseSchema },
  };

  registry.registerPath({
    method: 'post',
    path: '/api/v1/urls',
    tags: ['URLs'],
    summary: 'Create Short URL',
    description:
      'Validate longUrl, generate a random 7-character Base62 short code, store in PostgreSQL, and warm Upstash Redis cache. Requires API key. Rate limited more strictly than other routes (per IP).',
    security: [{ ApiKeyAuth: [] }],
    request: {
      body: {
        required: true,
        content: {
          'application/json': { schema: createUrlSchema },
        },
      },
    },
    parameters: [requestIdParam],
    responses: {
      201: {
        description: 'Short URL created successfully',
        content: {
          'application/json': { schema: urlResponseSchema },
        },
      },
      400: { description: 'Bad request', content: errorContent },
      401: { description: 'Missing or invalid API key', content: errorContent },
      429: { description: 'Too many create requests', content: errorContent },
      500: { description: 'Internal server error', content: errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/urls/{shortCode}',
    tags: ['URLs'],
    summary: 'Get URL Metadata',
    description:
      'Returns metadata for an active, non-expired short URL. Public (no API key).',
    request: {
      params: shortCodeParamSchema,
    },
    parameters: [requestIdParam],
    responses: {
      200: {
        description: 'URL metadata',
        content: {
          'application/json': { schema: urlResponseSchema },
        },
      },
      400: { description: 'Invalid short code', content: errorContent },
      404: {
        description: 'Not found, inactive, or expired',
        content: errorContent,
      },
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/v1/urls/{shortCode}',
    tags: ['URLs'],
    summary: 'Deactivate Short URL',
    description:
      'Soft-disables the URL (`is_active = false`) and deletes the Upstash cache key. Requires API key.',
    security: [{ ApiKeyAuth: [] }],
    request: {
      params: shortCodeParamSchema,
    },
    parameters: [requestIdParam],
    responses: {
      200: {
        description: 'URL deactivated',
        content: {
          'application/json': { schema: urlResponseSchema },
        },
      },
      401: { description: 'Missing or invalid API key', content: errorContent },
      404: {
        description: 'Already inactive or missing',
        content: errorContent,
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/{shortCode}',
    tags: ['URLs'],
    summary: 'Redirect Short URL',
    description:
      'Resolve via Upstash Redis (HIT) or PostgreSQL (MISS + cache-aside). Returns 302. Public (no API key).',
    request: {
      params: shortCodeParamSchema,
    },
    parameters: [requestIdParam],
    responses: {
      302: {
        description: 'Redirect to long URL',
        headers: {
          Location: {
            schema: { type: 'string', format: 'uri' },
            description: 'Destination long URL',
          },
        },
      },
      400: { description: 'Invalid short code', content: errorContent },
      404: {
        description: 'Not found, inactive, or expired',
        content: errorContent,
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['Health'],
    summary: 'Liveness Probe',
    description: 'Process is up. Does not check database or Redis.',
    responses: {
      200: {
        description: 'OK',
        content: {
          'application/json': { schema: healthResponseSchema },
        },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/ready',
    tags: ['Health'],
    summary: 'Readiness Probe',
    description: 'Checks PostgreSQL and Upstash Redis.',
    responses: {
      200: {
        description: 'Ready',
        content: {
          'application/json': { schema: readyResponseSchema },
        },
      },
      503: {
        description: 'Not ready',
        content: {
          'application/json': { schema: readyResponseSchema },
        },
      },
    },
  });

  const baseUrl =
    process.env.BASE_URL?.replace(/\/$/, '') || 'http://localhost:3001';

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Express API for URL Shortener',
      version: '1.0.0',
      description:
        'REST API built with Express.js, Prisma, Upstash Redis, and Zod. Shortens URLs, redirects with cache-aside Redis, and supports soft-deactivate. Create/delete require an API key (`x-api-key`).',
    },
    servers: [
      { url: baseUrl, description: 'Configured BASE_URL' },
      { url: 'http://localhost:3001', description: 'DEV server (local)' },
    ],
    tags: [
      {
        name: 'URLs',
        description: 'Create, inspect, deactivate, and redirect short URLs',
      },
      {
        name: 'Health',
        description: 'Liveness and readiness probes',
      },
    ],
  });
}
