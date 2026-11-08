/**
 * YouTube API quota ledger (PRD 4.10). "A quota bug is an outage":
 * every YouTube API call goes through `spend()` BEFORE it is made.
 *
 * - Units are counted per Pacific day (YouTube resets at midnight PT).
 * - Redis keeps a cross-process counter; without Redis the count is
 *   seeded from `quota_events` and kept in memory.
 * - 70% → operator alert, 90% → new streams start in fallback mode,
 *   100% → calls are refused.
 */
import type { Redis } from 'ioredis';
import type { Db } from './db/types';
import type { Logger } from './log';
import { pacificDayKey, pacificDayStart } from './time';
import type { QuotaEventRow } from './types';

/** Costs from the YouTube Data API / Live Streaming API reference pages (checked 2026-11-08). */
export const YT_QUOTA_COST: Record<string, number> = {
  'videos.list': 1,
  'channels.list': 1,
  'liveBroadcasts.list': 1,
  'liveChatMessages.list': 5,
  'liveChatMessages.streamList': 5,
  'search.list': 100,
};

export type QuotaMode = 'normal' | 'alert' | 'fallback' | 'exhausted';

export class QuotaExceededError extends Error {
  constructor(method: string, used: number, limit: number) {
    super(`YouTube quota exhausted: ${method} refused (${used}/${limit} units today)`);
    this.name = 'QuotaExceededError';
  }
}

export interface QuotaLedgerOptions {
  db: Db;
  redis?: Redis | null;
  dailyLimit: number;
  log?: Logger;
  alertRatio?: number;
  fallbackRatio?: number;
  onAlert?: (level: 'alert' | 'fallback' | 'exhausted', used: number, limit: number) => void;
}

export class QuotaLedger {
  private local = new Map<string, number>();
  private buffer: QuotaEventRow[] = [];
  private alerted = new Map<string, Set<string>>();
  private seeded = new Set<string>();
  private timer: NodeJS.Timeout;
  readonly alertRatio: number;
  readonly fallbackRatio: number;

  constructor(private opts: QuotaLedgerOptions) {
    this.alertRatio = opts.alertRatio ?? 0.7;
    this.fallbackRatio = opts.fallbackRatio ?? 0.9;
    this.timer = setInterval(() => void this.flush(), 5000);
    this.timer.unref();
  }

  get dailyLimit() {
    return this.opts.dailyLimit;
  }

  private redisKey(day: string) {
    return `ib:quota:${day}`;
  }

  private async seed(day: string) {
    if (this.seeded.has(day)) return;
    this.seeded.add(day);
    if (this.opts.redis) return;
    try {
      const fromDb = await this.opts.db.sumQuotaSince(pacificDayStart());
      this.local.set(day, Math.max(this.local.get(day) ?? 0, fromDb));
    } catch (err) {
      this.opts.log?.warn({ err }, 'could not seed quota from db');
    }
  }

  async usedToday(): Promise<number> {
    const day = pacificDayKey();
    await this.seed(day);
    if (this.opts.redis) {
      const v = await this.opts.redis.get(this.redisKey(day));
      return Number(v ?? 0);
    }
    return this.local.get(day) ?? 0;
  }

  async mode(): Promise<QuotaMode> {
    const used = await this.usedToday();
    return this.modeFor(used);
  }

  modeFor(used: number): QuotaMode {
    const r = used / this.opts.dailyLimit;
    if (r >= 1) return 'exhausted';
    if (r >= this.fallbackRatio) return 'fallback';
    if (r >= this.alertRatio) return 'alert';
    return 'normal';
  }

  /**
   * Records `units` for `method` and returns the new daily total.
   * Throws QuotaExceededError (without spending) if it would exceed the limit.
   */
  async spend(method: string, opts: { units?: number; streamId?: string | null } = {}): Promise<number> {
    const units = opts.units ?? YT_QUOTA_COST[method] ?? 1;
    const day = pacificDayKey();
    await this.seed(day);
    const before = await this.usedToday();
    if (before + units > this.opts.dailyLimit) {
      this.maybeAlert(day, 'exhausted', before);
      throw new QuotaExceededError(method, before, this.opts.dailyLimit);
    }
    let total: number;
    if (this.opts.redis) {
      const key = this.redisKey(day);
      total = await this.opts.redis.incrby(key, units);
      await this.opts.redis.expire(key, 3 * 24 * 3600);
    } else {
      total = (this.local.get(day) ?? 0) + units;
      this.local.set(day, total);
    }
    this.buffer.push({ ts: Date.now(), method, units, streamId: opts.streamId ?? null });
    const mode = this.modeFor(total);
    if (mode !== 'normal') this.maybeAlert(day, mode, total);
    return total;
  }

  private maybeAlert(day: string, level: 'alert' | 'fallback' | 'exhausted', used: number) {
    let set = this.alerted.get(day);
    if (!set) {
      set = new Set();
      this.alerted.set(day, set);
    }
    if (set.has(level)) return;
    set.add(level);
    this.opts.log?.warn({ level, used, limit: this.opts.dailyLimit }, 'youtube quota threshold');
    this.opts.onAlert?.(level, used, this.opts.dailyLimit);
  }

  async flush() {
    if (!this.buffer.length) return;
    const rows = this.buffer.splice(0);
    try {
      await this.opts.db.insertQuotaEvents(rows);
    } catch (err) {
      this.opts.log?.error({ err }, 'quota flush failed; re-queueing');
      this.buffer.unshift(...rows);
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
