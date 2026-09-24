import { randomBytes } from 'crypto';
import { Prisma, type Url } from '@prisma/client';
import { config } from '../config';
import { prisma } from '../db';
import {
  InternalServerError,
  NotFoundError,
} from '../errors';
import { RedisClient } from '../redis';
import type { CreateUrlInput } from './urls.schema';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SHORT_CODE_LENGTH = 7;
const CACHE_TTL_SECONDS = 60 * 60 * 24;
const MAX_GENERATION_ATTEMPTS = 5;

export class UrlsService {
  constructor(private readonly redis: RedisClient) {}

  async create(input: CreateUrlInput) {
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    const saved = await this.insertWithUniqueShortCode(input.longUrl, expiresAt);
    await this.cacheLongUrl(saved);
    return this.toResponse(saved);
  }

  async findMetadata(shortCode: string) {
    const url = await this.findActive(shortCode);
    return this.toResponse(url);
  }

  async resolveForRedirect(shortCode: string): Promise<string> {
    const cached = await this.redis.get(this.cacheKey(shortCode));
    if (cached) {
      void this.incrementClicks(shortCode);
      return cached;
    }

    const url = await this.findActive(shortCode);
    await this.cacheLongUrl(url);
    void this.incrementClicks(shortCode);
    return url.longUrl;
  }

  /**
   * Soft-disable a URL and immediately invalidate its Redis cache entry
   * so inactive URLs are never served from cache.
   */
  async deactivate(shortCode: string) {
    const url = await prisma.url.findUnique({ where: { shortCode } });
    if (!url || !url.isActive) {
      throw new NotFoundError('Short URL not found');
    }

    const updated = await prisma.url.update({
      where: { shortCode },
      data: { isActive: false },
    });
    await this.redis.del(this.cacheKey(shortCode));

    return this.toResponse(updated);
  }

  private async findActive(shortCode: string): Promise<Url> {
    const url = await prisma.url.findUnique({ where: { shortCode } });
    if (!url || !url.isActive) {
      throw new NotFoundError('Short URL not found');
    }
    if (url.expiresAt && url.expiresAt.getTime() <= Date.now()) {
      throw new NotFoundError('Short URL has expired');
    }
    return url;
  }

  /** Random Base62 insert; UNIQUE on short_code is the authority; retry on conflict. */
  private async insertWithUniqueShortCode(
    longUrl: string,
    expiresAt: Date | null,
  ): Promise<Url> {
    for (let i = 0; i < MAX_GENERATION_ATTEMPTS; i++) {
      const shortCode = this.randomBase62(SHORT_CODE_LENGTH);
      try {
        return await prisma.url.create({
          data: { shortCode, longUrl, expiresAt },
        });
      } catch (err) {
        if (this.isUniqueViolation(err)) {
          continue;
        }
        throw err;
      }
    }
    console.error(
      `Failed to generate unique short code after ${MAX_GENERATION_ATTEMPTS} attempts`,
    );
    throw new InternalServerError('Could not generate a unique short code');
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  private randomBase62(length: number): string {
    const bytes = randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
      result += BASE62[bytes[i] % 62];
    }
    return result;
  }

  private cacheKey(shortCode: string): string {
    return `url:${shortCode}`;
  }

  /**
   * TTL = min(24h, expiresAt − now). If no expiresAt → 24h.
   * Returns null when TTL would be <= 0 (do not cache).
   */
  private ttlFor(url: Url): number | null {
    if (!url.expiresAt) {
      return CACHE_TTL_SECONDS;
    }
    const seconds = Math.floor((url.expiresAt.getTime() - Date.now()) / 1000);
    if (seconds <= 0) {
      return null;
    }
    return Math.min(CACHE_TTL_SECONDS, seconds);
  }

  private async cacheLongUrl(url: Url): Promise<void> {
    const ttl = this.ttlFor(url);
    if (ttl === null) {
      return;
    }
    await this.redis.set(this.cacheKey(url.shortCode), url.longUrl, ttl);
  }

  private async incrementClicks(shortCode: string): Promise<void> {
    try {
      await prisma.url.update({
        where: { shortCode },
        data: { clickCount: { increment: 1 } },
      });
    } catch {
      // non-blocking analytics
    }
  }

  private toResponse(url: Url) {
    return {
      id: url.id,
      shortCode: url.shortCode,
      shortUrl: `${config.baseUrl.replace(/\/$/, '')}/${url.shortCode}`,
      longUrl: url.longUrl,
      createdAt: url.createdAt,
      expiresAt: url.expiresAt,
      isActive: url.isActive,
      clickCount: Number(url.clickCount),
    };
  }
}
