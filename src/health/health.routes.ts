import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../db';
import type { RedisClient } from '../redis';

export function createHealthRouter(redis: RedisClient): Router {
  const router = Router();

  /** Liveness — process is up. */
  router.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /** Readiness — Postgres + Redis reachable. */
  router.get(
    '/ready',
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [dbOk, redisOk] = await Promise.all([
          checkDatabase(),
          redis.ping(),
        ]);

        const ready = dbOk && redisOk;
        res.status(ready ? 200 : 503).json({
          status: ready ? 'ready' : 'not_ready',
          checks: {
            database: dbOk ? 'up' : 'down',
            redis: redisOk ? 'up' : 'down',
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
