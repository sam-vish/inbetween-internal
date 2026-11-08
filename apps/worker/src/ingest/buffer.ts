/**
 * Rolling buffer (PRD 4.2): the last 5 minutes of 2s MPEG-TS segments on
 * disk per stream, indexed by wall-clock time. Ranges pinned by pending
 * moments are never evicted until their source clip has been saved.
 */
import fs from 'node:fs/promises';

export interface Segment {
  path: string;
  startTs: number;
  endTs: number;
  /** Ingest session (increments on every reconnect). */
  session: number;
  index: number;
}

export interface Gap {
  fromTs: number;
  toTs: number;
}

export class RollingBuffer {
  private segments: Segment[] = [];
  private pins = new Map<number, { startTs: number; endTs: number }>();
  private pinSeq = 0;
  readonly gaps: Gap[] = [];
  evictedCount = 0;

  constructor(readonly retentionMs = 5 * 60_000) {}

  add(seg: Segment) {
    const last = this.segments.at(-1);
    if (last && seg.startTs - last.endTs > 1500) {
      this.gaps.push({ fromTs: last.endTs, toTs: seg.startTs });
      if (this.gaps.length > 500) this.gaps.shift();
    }
    this.segments.push(seg);
  }

  get latestTs(): number | null {
    return this.segments.at(-1)?.endTs ?? null;
  }

  get earliestTs(): number | null {
    return this.segments[0]?.startTs ?? null;
  }

  get size() {
    return this.segments.length;
  }

  covers(ts: number): boolean {
    const l = this.latestTs;
    return l != null && l >= ts;
  }

  /** Segments overlapping [startTs, endTs], in order. */
  segmentsFor(startTs: number, endTs: number): Segment[] {
    return this.segments.filter((s) => s.endTs > startTs && s.startTs < endTs);
  }

  pin(startTs: number, endTs: number): () => void {
    const id = ++this.pinSeq;
    this.pins.set(id, { startTs, endTs });
    return () => {
      this.pins.delete(id);
    };
  }

  private pinned(s: Segment) {
    for (const p of this.pins.values()) if (s.endTs > p.startTs && s.startTs < p.endTs) return true;
    return false;
  }

  /** Deletes segments older than the retention window (unless pinned). */
  async evict(nowTs: number): Promise<number> {
    const cutoff = nowTs - this.retentionMs;
    const keep: Segment[] = [];
    const drop: Segment[] = [];
    for (const s of this.segments) (s.endTs < cutoff && !this.pinned(s) ? drop : keep).push(s);
    this.segments = keep;
    await Promise.all(drop.map((s) => fs.rm(s.path, { force: true })));
    this.evictedCount += drop.length;
    return drop.length;
  }

  async clear() {
    await Promise.all(this.segments.map((s) => fs.rm(s.path, { force: true })));
    this.segments = [];
  }
}
