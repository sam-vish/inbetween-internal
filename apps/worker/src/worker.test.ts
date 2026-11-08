import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '@inbetween/render';
import { getLogger, LocalStorage, MemoryDb, parseClientConfig, scaledClock } from '@inbetween/shared';
import { describe, expect, it } from 'vitest';
import { handleAction } from './actions/processor';
import { createDeps } from './deps';
import { RollingBuffer } from './ingest/buffer';
import { IngestWorker } from './ingest/ingest';
import { MemoryQueue, type RenderJob } from './queue/index';
import { MockAsr, MockLlm, MockVision } from '@inbetween/providers';
import { loadEnv } from '@inbetween/shared';

const log = getLogger('test');

describe('rolling buffer', () => {
  it('indexes by time, records gaps, evicts old segments but keeps pinned ones', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-buf-'));
    const b = new RollingBuffer(10_000);
    const mk = async (i: number, start: number) => {
      const p = path.join(dir, `${i}.ts`);
      await fs.writeFile(p, 'x');
      b.add({ path: p, startTs: start, endTs: start + 2000, session: 1, index: i });
      return p;
    };
    await mk(0, 0);
    await mk(1, 2000);
    await mk(2, 10_000); // 6s gap
    await mk(3, 12_000);
    expect(b.gaps).toEqual([{ fromTs: 4000, toTs: 10_000 }]);
    expect(b.segmentsFor(1000, 3000).map((s) => s.index)).toEqual([0, 1]);
    expect(b.covers(14_000)).toBe(true);
    const unpin = b.pin(2500, 3500);
    expect(await b.evict(20_000)).toBe(1); // seg 0 evicted, seg 1 pinned
    expect(b.segmentsFor(0, 30_000).map((s) => s.index)).toEqual([1, 2, 3]);
    unpin();
    expect(await b.evict(20_000)).toBe(1);
    await expect(fs.stat(path.join(dir, '0.ts'))).rejects.toThrow();
  });
});

describe('memory queue', () => {
  it('dedupes job ids, retries failures and reports idle', async () => {
    const q = new MemoryQueue<number>('t', log);
    const seen: number[] = [];
    let failOnce = true;
    q.process(async (n) => {
      if (n === 2 && failOnce) {
        failOnce = false;
        throw new Error('boom');
      }
      seen.push(n);
    }, 1);
    await q.add(1, { jobId: 'a' });
    await q.add(1, { jobId: 'a' });
    await q.add(2);
    await new Promise((r) => setTimeout(r, 2500));
    await q.idle();
    expect(seen.sort()).toEqual([1, 2]);
  });
});

describe('ingest worker (real ffmpeg, file source)', () => {
  it('produces time-indexed segments, PCM and frames, then ends', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-ingest-'));
    const src = path.join(dir, 'in.mp4');
    await runProcess('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000:duration=8',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-c:a', 'aac', '-shortest', src,
    ]);
    const buffer = new RollingBuffer();
    const start = Date.now();
    const clock = scaledClock(start, 8);
    const w = new IngestWorker({ source: { kind: 'file', path: src, speed: 8 }, dir: path.join(dir, 'work'), clock, buffer, ffmpegBin: 'ffmpeg', log });
    let pcm = 0;
    let frames = 0;
    w.on('audio', (c) => (pcm += c.length));
    w.on('frame', () => frames++);
    const ended = new Promise<void>((r) => w.once('ended', () => r()));
    await w.start();
    await ended;
    await w.stop();
    expect(buffer.size).toBeGreaterThanOrEqual(3);
    const segs = buffer.segmentsFor(0, Number.MAX_SAFE_INTEGER);
    expect(segs[0].startTs).toBeGreaterThanOrEqual(start - 1000);
    expect(segs.at(-1)!.endTs - segs[0].startTs).toBeGreaterThan(7000);
    expect(pcm).toBeGreaterThan(16000 * 2 * 7); // ~8s of 16kHz mono s16le
    expect(frames).toBeGreaterThanOrEqual(6);
  });
});

describe('operator actions', () => {
  async function setup() {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-act-'));
    const env = loadEnv({ DATA_DIR: dataDir } as NodeJS.ProcessEnv, { fresh: true });
    const db = new MemoryDb();
    const deps = await createDeps(env, {
      db,
      storage: new LocalStorage(path.join(dataDir, 'storage')),
      redis: null,
      providers: { asr: new MockAsr(), liveAsr: null, vision: new MockVision(), llm: new MockLlm() },
    });
    const client = await db.createClient({
      name: 'C',
      youtubeChannelId: 'UC1',
      oauthRefreshTokenEnc: null,
      consentAt: null,
      config: parseClientConfig({}),
      delivery: { type: 'none', target: '' },
      active: true,
      baseline: null,
    });
    const stream = await db.createStream({ clientId: client.id, platform: 'youtube', videoId: 'v', liveChatId: 'c', title: null, startedAt: 0, game: null, status: 'live', workerHost: 'h' });
    const moment = await db.insertMoment({
      streamId: stream.id, clientId: client.id, eventTs: 100_000, startTs: 80_000, endTs: 115_000, score: 9, breakdown: {}, paidSuppressed: false,
      visionLabel: null, transcript: null, status: 'proposed', reason: null, label: null, chatSample: [], source: { key: 's', startTs: 70_000, endTs: 125_000, host: 'h' },
    });
    const clip = await db.insertClip({
      momentId: moment.id, clientId: client.id, streamId: stream.id, kind: 'fast', r2Key: 'k/fast-v1.mp4', thumbKey: null, sourceKey: 's',
      titles: ['A', 'B', 'C'], chosenTitle: 'A', burnedTitle: 'A', language: 'en', durationS: 35, renderMs: 1, startTs: 80_000, endTs: 115_000, needsReview: false,
    });
    const renders: RenderJob[] = [];
    const delivers: string[] = [];
    (deps.renderQueue as MemoryQueue<RenderJob>).process(async (j) => void renders.push(j), 1);
    (deps.deliverQueue as MemoryQueue<{ clipId: string }>).process(async (j) => void delivers.push(j.clipId), 1);
    return { deps, db, moment, clip, renders, delivers };
  }
  const act = (momentId: string, action: any, payload: Record<string, unknown> = {}) => ({
    id: 'a', momentId, clipId: null, action, payload, operatorEmail: 'op@x', createdAt: 0, processedAt: null, error: null,
  });

  it('approve with the burned title delivers directly; a new title re-renders then delivers', async () => {
    const { deps, db, moment, clip, renders, delivers } = await setup();
    await handleAction(deps, act(moment.id, 'approve'));
    await deps.deliverQueue.idle();
    expect(delivers).toEqual([clip.id]);
    expect((await db.getMoment(moment.id))!.status).toBe('approved');
    await handleAction(deps, act(moment.id, 'approve', { title: 'B' }));
    await deps.renderQueue.idle();
    expect(renders.at(-1)).toMatchObject({ reason: 'title', titleOverride: 'B', thenDeliver: true });
  });

  it('trim clamps to ±10s and the source range, then re-renders', async () => {
    const { deps, db, moment, renders } = await setup();
    await handleAction(deps, act(moment.id, 'trim', { startDeltaS: -30, endDeltaS: 5 }));
    await deps.renderQueue.idle();
    const m = (await db.getMoment(moment.id))!;
    expect(m.startTs).toBe(70_000); // -10s clamp, also the source start
    expect(m.endTs).toBe(120_000);
    expect(m.status).toBe('rendering');
    expect(renders.at(-1)).toMatchObject({ reason: 'trim', startTs: 70_000, endTs: 120_000 });
  });

  it('reject, title and premium update state', async () => {
    const { deps, db, moment, clip } = await setup();
    await handleAction(deps, act(moment.id, 'title', { title: 'New one' }));
    expect((await db.getClip(clip.id))!.chosenTitle).toBe('New one');
    await handleAction(deps, act(moment.id, 'premium'));
    expect((await db.getMoment(moment.id))!.status).toBe('premium');
    expect((await deps.premiumQueue.counts()).waiting).toBe(1);
    await handleAction(deps, act(moment.id, 'reject'));
    expect((await db.getMoment(moment.id))!.status).toBe('rejected');
  });
});
