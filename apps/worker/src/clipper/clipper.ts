/**
 * Clipper (PRD 4.6 steps 1–2): turns scorer moments into DB rows and source
 * clips. Waits for the post-roll segments to land (the main latency floor),
 * joins the segments covering [start − 10s, end + 10s] with `-c copy` into a
 * source clip (kept 30 days, so trims work after the 5-min buffer rolls),
 * then queues the fast-lane render.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { concatListFile, runProcess, sourceClipArgs } from '@inbetween/render';
import type { MomentCandidate } from '@inbetween/signals';
import { type ClientRecord, type Clock, type Logger, type MomentSource, sleep, storageKeys, type StreamRecord } from '@inbetween/shared';
import type { WorkerDeps } from '../deps';
import type { RollingBuffer } from '../ingest/buffer';
import type { RenderJob } from '../queue/index';

export const SOURCE_PAD_MS = 10_000;

export function sourcePath(dataDir: string, momentId: string) {
  return path.join(dataDir, 'sources', `${momentId}.ts`);
}

export function renderJobId(j: RenderJob) {
  return `${j.momentId}_${j.startTs}_${j.endTs}_${j.reason}_${j.titleOverride ? Buffer.from(j.titleOverride).toString('hex').slice(0, 16) : ''}`;
}

/** Joins buffered segments into a source clip. Returns the actual covered range. */
export async function buildSourceClip(
  buffer: RollingBuffer,
  startTs: number,
  endTs: number,
  out: string,
  ffmpegBin: string,
): Promise<{ startTs: number; endTs: number } | null> {
  const segs = buffer.segmentsFor(startTs, endTs);
  if (!segs.length) return null;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const list = `${out}.txt`;
  await fs.writeFile(list, concatListFile(segs.map((s) => s.path)));
  try {
    await runProcess(ffmpegBin, sourceClipArgs(list, out), { timeoutMs: 60_000 });
  } finally {
    await fs.rm(list, { force: true });
  }
  return { startTs: segs[0].startTs, endTs: segs[segs.length - 1].endTs };
}

export interface ClipperContext {
  deps: WorkerDeps;
  client: ClientRecord;
  stream: StreamRecord;
  buffer: RollingBuffer;
  clock: Clock;
  log: Logger;
  chatSample(fromTs: number, toTs: number): string[];
  transcriptAround(fromTs: number, toTs: number): string;
  isStopping(): boolean;
}

export class Clipper {
  private byKey = new Map<string, { momentId: string; source: MomentSource | null }>();
  private inflight = new Set<Promise<unknown>>();
  stats = { moments: 0, extends: 0, sourceFailures: 0 };

  constructor(private ctx: ClipperContext) {}

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  handleMoment(c: MomentCandidate) {
    void this.track(this.run(c).catch((err) => this.ctx.log.error({ err: (err as Error).message, key: c.key }, 'clipper failed')));
  }

  handleExtend(c: MomentCandidate) {
    void this.track(this.extend(c).catch((err) => this.ctx.log.error({ err: (err as Error).message, key: c.key }, 'clipper extend failed')));
  }

  /** Waits for in-flight moments (used at stream end). */
  async drain(timeoutMs = 120_000) {
    const all = Promise.allSettled([...this.inflight]);
    await Promise.race([all, sleep(timeoutMs)]);
  }

  private async waitForCoverage(ts: number, maxWaitMs = 90_000) {
    const t0 = Date.now();
    while (!this.ctx.buffer.covers(ts) && Date.now() - t0 < maxWaitMs && !this.ctx.isStopping()) await sleep(400);
    return this.ctx.buffer.covers(ts);
  }

  private async saveSource(momentId: string, startTs: number, endTs: number): Promise<MomentSource | null> {
    const { deps, client, buffer } = this.ctx;
    const unpin = buffer.pin(startTs - SOURCE_PAD_MS, endTs + SOURCE_PAD_MS);
    try {
      await this.waitForCoverage(endTs + 2000);
      const out = sourcePath(deps.dataDir, momentId);
      const range = await buildSourceClip(buffer, startTs - SOURCE_PAD_MS, endTs + SOURCE_PAD_MS, out, deps.env.FFMPEG_BIN);
      if (!range) return null;
      const key = storageKeys.source(client.id, momentId);
      // Upload in the background: the render reads the local file.
      void deps.storage.put(key, out, 'video/mp2t').catch((err) => this.ctx.log.warn({ err: (err as Error).message }, 'source upload failed'));
      return { key, startTs: range.startTs, endTs: range.endTs, host: deps.host };
    } finally {
      unpin();
    }
  }

  private async run(c: MomentCandidate) {
    const { deps, client, stream } = this.ctx;
    this.stats.moments++;
    deps.metrics.inc('moments_detected');
    const chatSample = this.ctx.chatSample((c.chatPeakTs ?? c.eventTs) - 6000, (c.chatPeakTs ?? c.eventTs) + 6000);
    const moment = await deps.db.insertMoment({
      streamId: stream.id,
      clientId: client.id,
      eventTs: c.eventTs,
      startTs: c.startTs,
      endTs: c.endTs,
      score: c.score,
      breakdown: c.breakdown,
      paidSuppressed: c.paidSuppressed,
      visionLabel: c.visionLabel,
      transcript: this.ctx.transcriptAround(c.startTs, c.endTs) || null,
      status: 'rendering',
      reason: c.reason,
      label: null,
      chatSample,
      source: null,
    });
    const entry = { momentId: moment.id, source: null as MomentSource | null };
    this.byKey.set(c.key, entry);
    this.ctx.log.info(
      { momentId: moment.id, score: c.score, eventTs: new Date(c.eventTs).toISOString(), reason: c.reason },
      'moment detected',
    );
    const source = await this.saveSource(moment.id, c.startTs, c.endTs);
    if (!source) {
      this.stats.sourceFailures++;
      await deps.db.updateMoment(moment.id, { status: 'failed', reason: `${c.reason}; no segments in buffer` });
      return;
    }
    entry.source = source;
    // The window may have been extended while we were waiting.
    const latest = await deps.db.getMoment(moment.id);
    await deps.db.updateMoment(moment.id, { source });
    await deps.renderQueue.add(
      { momentId: moment.id, startTs: latest?.startTs ?? c.startTs, endTs: latest?.endTs ?? c.endTs, reason: 'initial' },
      { jobId: renderJobId({ momentId: moment.id, startTs: c.startTs, endTs: c.endTs, reason: 'initial' }) },
    );
  }

  private async extend(c: MomentCandidate) {
    const { deps } = this.ctx;
    // The initial insert may still be in flight.
    for (let i = 0; i < 50 && !this.byKey.has(c.key); i++) await sleep(100);
    const entry = this.byKey.get(c.key);
    if (!entry) return;
    const m = await deps.db.getMoment(entry.momentId);
    if (!m || !['rendering', 'proposed'].includes(m.status)) return;
    this.stats.extends++;
    await deps.db.updateMoment(m.id, { endTs: c.endTs, score: Math.max(m.score, c.score), paidSuppressed: m.paidSuppressed || c.paidSuppressed });
    if (!entry.source) return; // initial run will pick up the new end
    let source = entry.source;
    if (source.endTs < c.endTs + 2000) {
      const rebuilt = await this.saveSource(m.id, m.startTs, c.endTs);
      if (rebuilt) {
        source = rebuilt;
        entry.source = rebuilt;
        await deps.db.updateMoment(m.id, { source });
      }
    }
    const job: RenderJob = { momentId: m.id, startTs: m.startTs, endTs: Math.min(c.endTs, source.endTs), reason: 'extend' };
    await deps.db.updateMoment(m.id, { status: 'rendering', endTs: job.endTs });
    await deps.renderQueue.add(job, { jobId: renderJobId(job) });
  }
}
