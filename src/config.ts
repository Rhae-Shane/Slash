import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();
dotenv.config({ path: '.env.local', override: true });

const postgresUrl = z
  .string()
  .min(1)
  .refine(
    (value) =>
      value.startsWith('postgresql://') || value.startsWith('postgres://'),
    'must be a postgresql:// connection string',
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  BASE_URL: z.url().default('http://localhost:3001'),
  DATABASE_URL: postgresUrl,
  DIRECT_URL: postgresUrl,
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  API_KEY: z.string().min(8, 'API_KEY must be at least 8 characters'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_CREATE_MAX: z.coerce.number().int().positive().default(20),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
    .join('\n');
  console.error('Invalid environment configuration:\n' + details);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  port: env.PORT,
  baseUrl: env.BASE_URL,
  databaseUrl: env.DATABASE_URL,
  directUrl: env.DIRECT_URL,
  apiKey: env.API_KEY,
  redis: {
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  },
  logLevel: env.LOG_LEVEL,
  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    createMax: env.RATE_LIMIT_CREATE_MAX,
  },
} as const;
