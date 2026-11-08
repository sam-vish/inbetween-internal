/**
 * Job queues (BullMQ on Redis; an in-process queue when Redis is absent).
 * - `render@<host>`: fast-lane renders/re-renders (host-local: segments live on that disk)
 * - `deliver`:      client delivery
 * - `premium`:      premium-lane jobs, consumed by apps/premium
 */
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger, Redis } from '@inbetween/shared';

export interface JobOptions {
  jobId?: string;
  attempts?: number;
  delayMs?: number;
}

export interface JobQueue<T> {
  readonly name: string;
  add(data: T, opts?: JobOptions): Promise<void>;
  process(handler: (data: T) => Promise<void>, concurrency: number): void;
  counts(): Promise<{ waiting: number; active: number; failed: number }>;
  /** Resolves once nothing is waiting or running (memory queue only; used by replay/tests). */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export class MemoryQueue<T> implements JobQueue<T> {
  private items: Array<{ data: T; attempts: number; id?: string }> = [];
  private active = 0;
  private failed = 0;
  private handler: ((data: T) => Promise<void>) | null = null;
  private concurrency = 1;
  private ids = new Set<string>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    readonly name: string,
    private log: Logger,
  ) {}

  async add(data: T, opts: JobOptions = {}) {
    if (opts.jobId) {
      if (this.ids.has(opts.jobId)) return;
      this.ids.add(opts.jobId);
    }
    const push = () => {
      this.items.push({ data, attempts: opts.attempts ?? 2, id: opts.jobId });
      this.pump();
    };
    if (opts.delayMs) setTimeout(push, opts.delayMs).unref();
    else push();
  }

  process(handler: (data: T) => Promise<void>, concurrency: number) {
    this.handler = handler;
    this.concurrency = concurrency;
    this.pump();
  }

  private pump() {
    if (!this.handler) return;
    while (this.active < this.concurrency && this.items.length) {
      const item = this.items.shift()!;
      this.active++;
      this.handler(item.data)
        .catch((err) => {
          item.attempts--;
          this.log.error({ queue: this.name, err: (err as Error).message, attemptsLeft: item.attempts }, 'job failed');
          if (item.attempts > 0) setTimeout(() => {
            this.items.push(item);
            this.pump();
          }, 2000).unref();
          else this.failed++;
        })
        .finally(() => {
          this.active--;
          if (item.id) this.ids.delete(item.id);
          this.pump();
          if (!this.active && !this.items.length) for (const w of this.idleWaiters.splice(0)) w();
        });
    }
  }

  async counts() {
    return { waiting: this.items.length, active: this.active, failed: this.failed };
  }

  idle() {
    if (!this.active && !this.items.length) return Promise.resolve();
    return new Promise<void>((r) => this.idleWaiters.push(r));
  }

  async close() {
    this.items = [];
  }
}

export class BullQueue<T> implements JobQueue<T> {
  private queue: Queue;
  private worker: Worker | null = null;

  constructor(
    readonly name: string,
    private connection: Redis,
    private log: Logger,
  ) {
    this.queue = new Queue(name, { connection: connection as unknown as ConnectionOptions, prefix: 'ib' });
  }

  async add(data: T, opts: JobOptions = {}) {
    await this.queue.add(this.name, data as object, {
      jobId: opts.jobId,
      attempts: opts.attempts ?? 2,
      delay: opts.delayMs,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    });
  }

  process(handler: (data: T) => Promise<void>, concurrency: number) {
    this.worker = new Worker(
      this.name,
      async (job) => {
        await handler(job.data as T);
      },
      { connection: this.connection.duplicate() as unknown as ConnectionOptions, concurrency, prefix: 'ib', lockDuration: 300_000 },
    );
    this.worker.on('failed', (job, err) => this.log.error({ queue: this.name, jobId: job?.id, err: err.message }, 'job failed'));
  }

  async counts() {
    const c = await this.queue.getJobCounts('waiting', 'active', 'failed', 'delayed');
    return { waiting: (c.waiting ?? 0) + (c.delayed ?? 0), active: c.active ?? 0, failed: c.failed ?? 0 };
  }

  async idle() {
    for (;;) {
      const c = await this.counts();
      if (!c.waiting && !c.active) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async close() {
    await this.worker?.close();
    await this.queue.close();
  }
}

export function createQueue<T>(name: string, redis: Redis | null, log: Logger): JobQueue<T> {
  return redis ? new BullQueue<T>(name, redis, log) : new MemoryQueue<T>(name, log);
}

// ---- job payloads ----

export interface RenderJob {
  momentId: string;
  startTs: number;
  endTs: number;
  reason: 'initial' | 'extend' | 'trim' | 'title' | 'rerender';
  /** Burn this title instead of generating/choosing one. */
  titleOverride?: string | null;
  /** Deliver right after rendering (approve with a changed title). */
  thenDeliver?: boolean;
}

export interface DeliverJob {
  clipId: string;
}

export interface PremiumJob {
  momentId: string;
  requestedBy: string | null;
}
