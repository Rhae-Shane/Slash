import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

const MAX_LONG_URL_LENGTH = 2048;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const createUrlSchema = z
  .object({
    longUrl: z
      .string()
      .trim()
      .min(1, 'longUrl is required')
      .max(
        MAX_LONG_URL_LENGTH,
        `longUrl must be at most ${MAX_LONG_URL_LENGTH} characters`,
      )
      .refine(isHttpUrl, 'longUrl must be a valid http(s) URL')
      .openapi({
        description: 'Destination URL (http or https only)',
        example: 'https://example.com/very/long/path',
        maxLength: MAX_LONG_URL_LENGTH,
      }),
    expiresAt: z.iso
      .datetime()
      .optional()
      .openapi({
        description: 'Optional ISO-8601 expiry; must be in the future',
        example: '2026-12-31T23:59:59.000Z',
      }),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (!data.expiresAt) {
      return;
    }
    const expiresAt = new Date(data.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be a valid ISO date string',
      });
      return;
    }
    if (expiresAt.getTime() <= Date.now()) {
      ctx.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be in the future',
      });
    }
  })
  .openapi('CreateUrlRequest');

export type CreateUrlInput = z.infer<typeof createUrlSchema>;

export const shortCodeParamSchema = z
  .object({
    shortCode: z
      .string()
      .trim()
      .min(1, 'shortCode is required')
      .max(16, 'shortCode must be at most 16 characters')
      .regex(/^[0-9A-Za-z]+$/, 'shortCode must be Base62')
      .openapi({
        description: 'Base62 short code (1–16 chars)',
        example: 'aB3xY9k',
      }),
  })
  .openapi('ShortCodeParams');

export const urlResponseSchema = z
  .object({
    id: z.string().uuid().openapi({ example: '550e8400-e29b-41d4-a716-446655440000' }),
    shortCode: z.string().openapi({ example: 'aB3xY9k' }),
    shortUrl: z.string().url().openapi({ example: 'http://localhost:3001/aB3xY9k' }),
    longUrl: z.string().url().openapi({ example: 'https://example.com/very/long/path' }),
    createdAt: z.string().datetime().openapi({ example: '2026-03-23T05:30:00.000Z' }),
    expiresAt: z
      .string()
      .datetime()
      .nullable()
      .openapi({ example: '2026-12-31T23:59:59.000Z' }),
    isActive: z.boolean().openapi({ example: true }),
    clickCount: z.number().int().nonnegative().openapi({ example: 0 }),
  })
  .openapi('UrlResponse');

export const errorResponseSchema = z
  .object({
    statusCode: z.number().int().openapi({ example: 400 }),
    message: z.string().openapi({ example: 'longUrl must be a valid http(s) URL' }),
    requestId: z
      .string()
      .uuid()
      .openapi({ example: '7c9e6679-7425-40de-944b-e07fc1f90ae7' }),
  })
  .openapi('ErrorResponse');

export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    timestamp: z.string().datetime(),
  })
  .openapi('HealthResponse');

export const readyResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    checks: z.object({
      database: z.enum(['up', 'down']),
      redis: z.enum(['up', 'down']),
    }),
    timestamp: z.string().datetime(),
  })
  .openapi('ReadyResponse');
