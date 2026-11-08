import { Redis } from 'ioredis';

export type { Redis };

/** Returns a Redis client, or null when REDIS_URL is not configured (in-memory mode). */
export function createRedis(url: string | undefined, opts: { forBullMq?: boolean } = {}): Redis | null {
  if (!url) return null;
  return new Redis(url, {
    // BullMQ requires maxRetriesPerRequest=null on its blocking connections.
    maxRetriesPerRequest: opts.forBullMq ? null : 3,
    enableReadyCheck: true,
    lazyConnect: false,
  });
}
