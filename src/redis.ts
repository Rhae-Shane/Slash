import { Redis } from '@upstash/redis';
import { config } from './config';
import { logger } from './logger';

type RedisOp = 'get' | 'set' | 'del' | 'ping';

export class RedisClient {
  private readonly client: Redis;
  private readonly failureCounts: Record<RedisOp, number> = {
    get: 0,
    set: 0,
    del: 0,
    ping: 0,
  };

  constructor() {
    this.client = new Redis({
      url: config.redis.url,
      token: config.redis.token,
    });
  }

  /** Best-effort counters for graceful-degrade observability. */
  getFailureCounts(): Readonly<Record<RedisOp, number>> {
    return { ...this.failureCounts };
  }

  private recordFailure(op: RedisOp, err: unknown): void {
    this.failureCounts[op] += 1;
    logger.warn(
      {
        err,
        op,
        redisFailures: this.failureCounts[op],
        metric: 'redis_cache_error',
      },
      `Redis ${op} failed; continuing without cache`,
    );
  }

  async get(key: string): Promise<string | null> {
    try {
      const value = await this.client.get<string>(key);
      return value ?? null;
    } catch (err) {
      this.recordFailure('get', err);
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      return;
    }
    try {
      await this.client.set(key, value, { ex: ttlSeconds });
    } catch (err) {
      this.recordFailure('set', err);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.recordFailure('del', err);
    }
  }

  async ping(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (err) {
      this.recordFailure('ping', err);
      return false;
    }
  }

  async quit(): Promise<void> {
    // Upstash REST has no persistent connection to close
  }
}
