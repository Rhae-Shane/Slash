import { Router, type Request, type Response, type NextFunction } from 'express';
import type { RequestHandler } from 'express';
import { ZodError } from 'zod';
import { BadRequestError } from '../errors';
import { requireApiKey } from '../middleware/api-key';
import { createUrlSchema, shortCodeParamSchema } from './urls.schema';
import type { UrlsService } from './urls.service';

function formatZodError(err: ZodError): string {
  return err.issues.map((issue) => issue.message).join('; ');
}

function parseOrThrow<T>(
  schema: { parse: (data: unknown) => T },
  data: unknown,
): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestError(formatZodError(err));
    }
    throw err;
  }
}

export type UrlsRouterOptions = {
  createUrlLimiter?: RequestHandler;
};

export function createUrlsRouter(
  urlsService: UrlsService,
  options: UrlsRouterOptions = {},
): Router {
  const router = Router();
  const createMiddleware = [
    requireApiKey,
    ...(options.createUrlLimiter ? [options.createUrlLimiter] : []),
  ];

  router.post(
    '/api/v1/urls',
    ...createMiddleware,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const input = parseOrThrow(createUrlSchema, req.body);
        const result = await urlsService.create(input);
        req.log.info(
          { requestId: req.id, shortCode: result.shortCode },
          'short url created',
        );
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/api/v1/urls/:shortCode',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { shortCode } = parseOrThrow(shortCodeParamSchema, {
          shortCode: req.params.shortCode,
        });
        const result = await urlsService.findMetadata(shortCode);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/api/v1/urls/:shortCode',
    requireApiKey,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { shortCode } = parseOrThrow(shortCodeParamSchema, {
          shortCode: req.params.shortCode,
        });
        const result = await urlsService.deactivate(shortCode);
        req.log.info(
          { requestId: req.id, shortCode },
          'short url deactivated',
        );
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/:shortCode',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { shortCode } = parseOrThrow(shortCodeParamSchema, {
          shortCode: req.params.shortCode,
        });
        const longUrl = await urlsService.resolveForRedirect(shortCode);
        req.log.info({ requestId: req.id, shortCode }, 'redirect resolved');
        res.redirect(302, longUrl);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
