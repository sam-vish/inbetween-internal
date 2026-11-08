import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MockAsr, MockLlm, MockVision } from '@inbetween/providers';
import { probeMedia, runProcess } from '@inbetween/render';
import { LocalStorage, loadEnv, MemoryDb, parseClientConfig } from '@inbetween/shared';
import { createDeps } from '@inbetween/worker';
import { afterAll, describe, expect, it } from 'vitest';
import { compileForClient } from './compile';
import { claudeCodePrompt, JOBS_DIR, runPremiumJob } from './premium';

const created: string[] = [];
afterAll(async () => {
  for (const d of created) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-prem-'));
  created.push(dataDir);
  const env = loadEnv({ DATA_DIR: dataDir } as NodeJS.ProcessEnv, { fresh: true });
  const db = new MemoryDb();
  const storage = new LocalStorage(path.join(dataDir, 'storage'));
  const deps = await createDeps(env, { db, storage, redis: null, providers: { asr: new MockAsr(), liveAsr: null, vision: new MockVision(), llm: new MockLlm() } });
  // A 30s source clip in storage, like the clipper saves.
  const src = path.join(dataDir, 'src.ts');
  await runProcess('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=30',
    '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000:duration=30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', '-f', 'mpegts', src,
  ]);
  const client = await db.createClient({ name: 'Rahul', youtubeChannelId: 'UC1', oauthRefreshTokenEnc: null, consentAt: Date.now(), config: parseClientConfig({ caption_language: 'hinglish' }), delivery: { type: 'none', target: '' }, active: true, baseline: null });
  const stream = await db.createStream({ clientId: client.id, platform: 'youtube', videoId: 'v', liveChatId: null, title: null, startedAt: 0, game: 'GTA VI', status: 'ended', workerHost: 'h' });
  const t0 = Date.now() - 3600_000;
  const moments = [];
  for (const [i, status] of (['approved', 'delivered'] as const).entries()) {
    const m = await db.insertMoment({
      streamId: stream.id, clientId: client.id, eventTs: t0 + 15_000 + i * 1000, startTs: t0 + 5_000, endTs: t0 + 15_000, score: 9 - i, breakdown: {}, paidSuppressed: false,
      visionLabel: 'crash', transcript: 'arre bhai', status, reason: null, label: 'Cop car flip', chatSample: ['LOL'], source: { key: `sources/${client.id}/m${i}.ts`, startTs: t0, endTs: t0 + 30_000, host: 'h' },
    });
    await storage.put(`sources/${client.id}/m${i}.ts`, src, 'video/mp2t');
    moments.push(m);
  }
  return { deps, db, client, moments };
}

describe('premium lane', () => {
  it('prepares the job folder and storyboard without Claude Code', async () => {
    const { deps, moments } = await setup();
    const r = await runPremiumJob(deps, moments[0].id, { skipClaudeCode: true });
    const dir = path.join(JOBS_DIR, moments[0].id);
    created.push(dir);
    expect(r.brief.beats.length).toBeGreaterThan(0);
    const job = JSON.parse(await fs.readFile(path.join(dir, 'job.json'), 'utf8'));
    expect(job.client.captionLanguage).toBe('hinglish');
    const info = await probeMedia('ffprobe', path.join(dir, 'source.mp4'));
    expect(info.durationS).toBeGreaterThan(13.5); // 10s window ± 2s
    expect(info.durationS).toBeLessThan(14.6);
    expect(claudeCodePrompt(`jobs/${moments[0].id}`)).toContain('out/premium.mp4');
    await deps.close();
  });

  it('builds a weekly compilation with chapters, stored for review', async () => {
    const { deps, db, client } = await setup();
    const r = await compileForClient(deps, client.id, 7, 10);
    expect(r).not.toBeNull();
    created.push(path.dirname(r!.out));
    expect(r!.chapters).toHaveLength(2);
    expect(r!.chapters[0]).toMatch(/^0:00 /);
    const clip = await db.getClip(r!.clipId);
    expect(clip).toMatchObject({ kind: 'compilation', needsReview: true });
    const info = await probeMedia('ffprobe', r!.out);
    expect(info.width).toBe(1920);
    expect(info.durationS).toBeGreaterThan(23); // 2 × (2s card + 10s clip)
    await deps.close();
  });
});
