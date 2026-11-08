/**
 * Replays a recorded VOD + saved chat log through the full pipeline as if it
 * were live (PRD 11). Use it to tune thresholds/weights without waiting for
 * streams.
 *
 *   tsx scripts/replay.ts --video vod.mp4 --chat vod.live_chat.json \
 *     [--client client-config.json] [--name "Creator"] [--speed 1] \
 *     [--memory] [--auto-approve] [--report out.json]
 *
 * Chat formats: yt-dlp `.live_chat.json` (yt-dlp --write-subs --sub-langs live_chat <url>)
 * or simple JSONL {"t": seconds, "author", "text", "paid", "amount"}.
 *
 * --memory forces an in-memory DB, local storage and no Redis (fully offline).
 * Internal tuning only: nothing from non-clients is ever published, and the
 * replay's data dir can be deleted after the session (PRD 6).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseRecordedChat } from '@inbetween/adapters';
import { createProviders } from '@inbetween/providers';
import { type ChatEvent, LocalStorage, loadDotEnv, loadEnv, MemoryDb, parseClientConfig, Pricing, scaledClock } from '@inbetween/shared';
import {
  ActionProcessor,
  createDeps,
  type DepsOverrides,
  parseSimpleChatJsonl,
  percentile,
  processDeliverJob,
  processRenderJob,
  ReplayAdapter,
  StreamPipeline,
} from '@inbetween/worker';

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
}

export interface ReplayReport {
  video: string;
  speed: number;
  streamId: string;
  moments: Array<{
    id: string;
    eventOffsetS: number;
    startOffsetS: number;
    endOffsetS: number;
    score: number;
    status: string;
    reason: string | null;
    paidSuppressed: boolean;
    titles: string[];
    clip: string | null;
    renderMs: number | null;
  }>;
  latency: { p50_ms: number | null; p95_ms: number | null; n: number };
  costUsd: number;
  signalRows: number;
  wallS: number;
}

export async function runReplay(o: {
  video: string;
  chatFile?: string;
  chatEvents?: ChatEvent[];
  clientConfig?: unknown;
  name?: string;
  speed?: number;
  memory?: boolean;
  /** With memory: still use REDIS_URL for the signal bus + BullMQ queues. */
  useRedis?: boolean;
  autoApprove?: boolean;
  dataDir?: string;
}): Promise<ReplayReport> {
  const t0 = Date.now();
  loadDotEnv();
  const env = loadEnv(process.env, { fresh: true });
  if (o.dataDir) env.DATA_DIR = o.dataDir;
  const overrides: DepsOverrides = {};
  if (o.memory) {
    overrides.db = new MemoryDb();
    overrides.storage = new LocalStorage(path.resolve(env.DATA_DIR, 'storage'));
    if (!o.useRedis) overrides.redis = null;
    const pricing = new Pricing(env.PRICING_OVERRIDES_JSON);
    overrides.providers = createProviders(
      { ...env, ASR_PROVIDER: env.ASR_PROVIDER ?? 'mock', VISION_PROVIDER: env.VISION_PROVIDER ?? 'mock', LLM_PROVIDER: env.LLM_PROVIDER ?? 'mock' },
      pricing,
    );
  }
  const deps = await createDeps(env, overrides);
  const speed = Number(o.speed ?? 1);

  let chat: ChatEvent[] = o.chatEvents ?? [];
  if (o.chatFile) {
    const content = fs.readFileSync(o.chatFile, 'utf8');
    chat = content.includes('replayChatItemAction') ? parseRecordedChat('youtube', content) : parseSimpleChatJsonl(content);
  }

  const client = await deps.db.createClient({
    name: o.name ?? `replay:${path.basename(o.video)}`,
    youtubeChannelId: 'replay',
    oauthRefreshTokenEnc: null,
    consentAt: null,
    config: parseClientConfig(o.clientConfig ?? {}),
    delivery: { type: 'none', target: '' },
    active: false,
    baseline: null,
  });
  const startTs = Date.now();
  const clock = scaledClock(startTs, speed);
  const adapter = new ReplayAdapter({ videoPath: o.video, chat, speed, clock, startTs });
  const session = adapter.session();
  const stream = await deps.db.createStream({
    clientId: client.id,
    platform: 'replay',
    videoId: session.videoId,
    liveChatId: 'replay',
    title: session.title,
    startedAt: startTs,
    game: client.config.game,
    status: 'live',
    workerHost: deps.host,
  });

  deps.renderQueue.process((job) => processRenderJob(deps, job), env.RENDER_CONCURRENCY);
  deps.deliverQueue.process((job) => processDeliverJob(deps, job), 1);
  const actions = new ActionProcessor(deps, 500);
  actions.start();

  const pipeline = new StreamPipeline(deps, adapter, client, session, stream, { chatMode: 'stream', clock, endOnSourceEnd: true });
  await pipeline.start();
  deps.log.info({ video: o.video, chatEvents: chat.length, speed }, 'replay running');
  await pipeline.done;
  await deps.renderQueue.idle();

  if (o.autoApprove) {
    for (const m of await deps.db.listMoments(stream.id)) {
      if (m.status === 'proposed') await deps.db.insertOperatorAction({ momentId: m.id, clipId: null, action: 'approve', payload: {}, operatorEmail: 'replay' });
    }
    await actions.runOnce();
    await deps.renderQueue.idle();
    await deps.deliverQueue.idle();
  }
  actions.stop();

  const moments = await deps.db.listMoments(stream.id);
  const report: ReplayReport = {
    video: o.video,
    speed,
    streamId: stream.id,
    moments: [],
    latency: deps.metrics.latencySummary(),
    costUsd: deps.costs.streamTotal(stream.id),
    signalRows: deps.db instanceof MemoryDb ? deps.db.signalSamples.filter((r) => r.streamId === stream.id).length : -1,
    wallS: Math.round((Date.now() - t0) / 1000),
  };
  for (const m of moments) {
    const clip = await deps.db.getLatestClip(m.id, 'fast');
    report.moments.push({
      id: m.id,
      eventOffsetS: (m.eventTs - startTs) / 1000,
      startOffsetS: (m.startTs - startTs) / 1000,
      endOffsetS: (m.endTs - startTs) / 1000,
      score: m.score,
      status: (await deps.db.getMoment(m.id))!.status,
      reason: m.reason,
      paidSuppressed: m.paidSuppressed,
      titles: clip?.titles ?? [],
      clip: clip ? (deps.storage instanceof LocalStorage ? deps.storage.pathFor(clip.r2Key) : clip.r2Key) : null,
      renderMs: clip?.renderMs ?? null,
    });
  }
  void percentile;
  await deps.close();
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const video = arg('video');
  if (!video) {
    console.error('usage: tsx scripts/replay.ts --video vod.mp4 --chat chat.json [--client cfg.json] [--speed 1] [--memory] [--auto-approve]');
    process.exit(2);
  }
  const clientFile = arg('client');
  const report = await runReplay({
    video,
    chatFile: arg('chat'),
    clientConfig: clientFile ? JSON.parse(fs.readFileSync(clientFile, 'utf8')) : {},
    name: arg('name'),
    speed: Number(arg('speed', '1')),
    memory: arg('memory') === 'true',
    autoApprove: arg('auto-approve') === 'true',
  });
  const out = arg('report', path.resolve(process.env.DATA_DIR ?? 'data', `replay-report-${Date.now()}.json`))!;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, moments: report.moments.map((m) => ({ at: m.eventOffsetS, score: m.score, status: m.status, title: m.titles[0], clip: m.clip })) }, null, 2));
  console.log(`report: ${out}`);
  process.exit(0);
}
