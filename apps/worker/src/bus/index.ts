/**
 * Signal bus (PRD 3): per-second signal values and paid/burst events flow
 * from signal workers to the scorer through Redis Streams (`ib:sig:<streamId>`),
 * so signal workers can also run as separate processes. Without Redis an
 * in-process bus is used.
 */
import { EventEmitter } from 'node:events';
import type { BusEvent, Logger, Redis } from '@inbetween/shared';

export interface SignalBus {
  publish(streamId: string, ev: BusEvent): void;
  subscribe(streamId: string, handler: (ev: BusEvent) => void): () => void;
  close(): Promise<void>;
}

export class MemoryBus implements SignalBus {
  private em = new EventEmitter();
  constructor() {
    this.em.setMaxListeners(1000);
  }
  publish(streamId: string, ev: BusEvent) {
    this.em.emit(streamId, ev);
  }
  subscribe(streamId: string, handler: (ev: BusEvent) => void) {
    this.em.on(streamId, handler);
    return () => this.em.off(streamId, handler);
  }
  async close() {
    this.em.removeAllListeners();
  }
}

export class RedisStreamBus implements SignalBus {
  private readers = new Set<{ stop: () => void }>();
  private pending: BusEvent[] = [];
  private pendingKey = new Map<string, BusEvent[]>();
  private flushTimer: NodeJS.Timeout;

  constructor(
    private redis: Redis,
    private log: Logger,
    private maxLen = 20_000,
  ) {
    // Batch XADDs every 100ms through one pipeline.
    this.flushTimer = setInterval(() => void this.flush(), 100);
    this.flushTimer.unref();
    void this.pending;
  }

  static key(streamId: string) {
    return `ib:sig:${streamId}`;
  }

  publish(streamId: string, ev: BusEvent) {
    const list = this.pendingKey.get(streamId) ?? [];
    list.push(ev);
    this.pendingKey.set(streamId, list);
  }

  private async flush() {
    if (!this.pendingKey.size) return;
    const batches = [...this.pendingKey.entries()];
    this.pendingKey.clear();
    const pipe = this.redis.pipeline();
    for (const [streamId, evs] of batches) {
      for (const ev of evs) pipe.xadd(RedisStreamBus.key(streamId), 'MAXLEN', '~', String(this.maxLen), '*', 'e', JSON.stringify(ev));
      pipe.expire(RedisStreamBus.key(streamId), 24 * 3600);
    }
    try {
      await pipe.exec();
    } catch (err) {
      this.log.error({ err }, 'signal bus flush failed');
    }
  }

  subscribe(streamId: string, handler: (ev: BusEvent) => void) {
    const conn = this.redis.duplicate();
    let stopped = false;
    let lastId = '$';
    const loop = async () => {
      while (!stopped) {
        try {
          const res = (await conn.xread('COUNT', 1000, 'BLOCK', 1000, 'STREAMS', RedisStreamBus.key(streamId), lastId)) as
            | Array<[string, Array<[string, string[]]>]>
            | null;
          if (!res) continue;
          for (const [, entries] of res) {
            for (const [id, fields] of entries) {
              lastId = id;
              const i = fields.indexOf('e');
              if (i >= 0) {
                try {
                  handler(JSON.parse(fields[i + 1]) as BusEvent);
                } catch (err) {
                  this.log.error({ err }, 'signal handler error');
                }
              }
            }
          }
        } catch (err) {
          if (stopped) break;
          this.log.warn({ err: (err as Error).message }, 'signal bus read error; retrying');
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void loop();
    const reader = {
      stop: () => {
        stopped = true;
        conn.disconnect();
      },
    };
    this.readers.add(reader);
    return () => {
      reader.stop();
      this.readers.delete(reader);
    };
  }

  async close() {
    clearInterval(this.flushTimer);
    await this.flush();
    for (const r of this.readers) r.stop();
    this.readers.clear();
  }
}
