import rateLimit from 'express-rate-limit';
import { config } from '../config';

function isExemptPath(path: string): boolean {
  return (
    path === '/health' ||
    path === '/ready' ||
    path === '/openapi.json' ||
    path === '/api/openapi' ||
    path.startsWith('/api-docs')
  );
}

/** Global soft limit for all routes except health checks and docs. */
export const globalRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    statusCode: 429,
    message: 'Too many requests, please try again later',
  },
  skip: (req) => isExemptPath(req.path),
});

/** Stricter limit for short-URL creation. */
export const createUrlRateLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.createMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    statusCode: 429,
    message: 'Too many URL create requests, please try again later',
  },
});
