import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { pinoHttp } from 'pino-http';
import { AppError } from './errors';
import { createHealthRouter } from './health/health.routes';
import { logger } from './logger';
import {
  createUrlRateLimiter,
  globalRateLimiter,
} from './middleware/rate-limit';
import { requestIdMiddleware } from './middleware/request-id';
import { RedisClient } from './redis';
import { mountSwagger } from './swagger';
import { createUrlsRouter } from './urls/urls.routes';
import { UrlsService } from './urls/urls.service';

export type AppContext = {
  app: Express;
  redis: RedisClient;
};

export function createApp(): AppContext {
  const redis = new RedisClient();
  const urlsService = new UrlsService(redis);

  const app = express();

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as Request).id,
      customProps: (req) => ({
        requestId: (req as Request).id,
      }),
      serializers: {
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
      },
    }),
  );
  app.use(globalRateLimiter);
  app.use(express.json({ limit: '16kb' }));

  mountSwagger(app);
  app.use(createHealthRouter(redis));

  const urlsRouter = createUrlsRouter(urlsService, {
    createUrlLimiter: createUrlRateLimiter,
  });
  app.use(urlsRouter);

  app.use(
    (err: unknown, req: Request, res: Response, _next: NextFunction) => {
      const requestId = req.id;

      if (err instanceof AppError) {
        logger.warn(
          { err, requestId, statusCode: err.statusCode },
          err.message,
        );
        res.status(err.statusCode).json({
          statusCode: err.statusCode,
          message: err.message,
          requestId,
        });
        return;
      }

      if (
        err instanceof SyntaxError &&
        'status' in err &&
        (err as { status?: number }).status === 400
      ) {
        res.status(400).json({
          statusCode: 400,
          message: 'Invalid JSON body',
          requestId,
        });
        return;
      }

      logger.error({ err, requestId }, 'Unhandled error');
      res.status(500).json({
        statusCode: 500,
        message: 'Internal server error',
        requestId,
      });
    },
  );

  return { app, redis };
}
