/**
 * Fast-lane render (PRD 4.6 steps 3–6):
 *   source clip → caption ASR (word timestamps) → script fix (Hinglish/Hindi)
 *   → Claude hook titles → ASS → one ffmpeg pass (cut + vertical + captions
 *   + title) → thumbnail → upload → clip row → dashboard (Realtime).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { needsTransliteration, type TitleResult } from '@inbetween/providers';
import { audioExtractArgs, buildAss, probeMedia, runProcess, thumbnailArgs, verticalRenderArgs } from '@inbetween/render';
import { type Clock, type MomentRecord, storageKeys, systemClock } from '@inbetween/shared';
import type { CaptionWord } from '@inbetween/render';
import { sourcePath } from '../clipper/clipper';
import type { WorkerDeps } from '../deps';
import type { RenderJob } from '../queue/index';

/** Stream clocks by stream id, so latency is measured in the stream's time domain (replay runs faster). */
export const streamClocks = new Map<string, Clock>();

async function ensureLocalSource(deps: WorkerDeps, m: MomentRecord): Promise<string> {
  const local = sourcePath(deps.dataDir, m.id);
  const exists = await fs
    .stat(local)
    .then((s) => s.size > 0)
    .catch(() => false);
  if (exists) return local;
  if (!m.source?.key) throw new Error(`moment ${m.id} has no source clip`);
  await deps.storage.download(m.source.key, local);
  return local;
}

function fallbackTitles(m: MomentRecord, creator: string): TitleResult {
  const label = m.visionLabel?.replace(/_/g, ' ') ?? 'moment';
  return { titles: [`${creator}'s wildest ${label}`, 'Chat lost it 💀', 'No way this happened'], label };
}

export async function processRenderJob(deps: WorkerDeps, job: RenderJob): Promise<void> {
  const log = deps.log.child({ mod: 'render', momentId: job.momentId, reason: job.reason });
  const m = await deps.db.getMoment(job.momentId);
  if (!m) return;
  if (m.startTs !== job.startTs || m.endTs !== job.endTs) {
    log.info('stale render job (window changed); skipping');
    return;
  }
  if (m.status === 'rejected') return;
  const client = await deps.db.getClient(m.clientId);
  const stream = await deps.db.getStream(m.streamId);
  if (!client || !stream) throw new Error('moment without client/stream');
  const cfg = client.config;
  const cost = deps.costs.reporter({ clientId: client.id, streamId: stream.id });
  const t0 = Date.now();

  const source = await ensureLocalSource(deps, m);
  const srcStart = m.source?.startTs ?? m.startTs - 10_000;
  const info = await probeMedia(deps.env.FFPROBE_BIN, source);
  const offsetS = Math.max(0, (m.startTs - srcStart) / 1000);
  const durationS = Math.max(1, Math.min((m.endTs - m.startTs) / 1000, info.durationS - offsetS));

  const prev = await deps.db.getLatestClip(m.id, 'fast');
  const version = (prev ? Number(prev.r2Key.match(/fast-v(\d+)\.mp4$/)?.[1] ?? 0) : 0) + 1;
  const work = path.join(deps.dataDir, 'renders', m.id, `v${version}`);
  await fs.mkdir(work, { recursive: true });

  // ---- captions: ASR with word timestamps ----
  let words: CaptionWord[] = [];
  let transcript = '';
  const asr = deps.providers.asr;
  if (asr && info.hasAudio) {
    const wav = path.join(work, 'audio.wav');
    await runProcess(deps.env.FFMPEG_BIN, audioExtractArgs(source, offsetS, durationS, wav), { timeoutMs: 60_000 });
    try {
      const r = await asr.transcribe(await fs.readFile(wav), { language: cfg.caption_language, purpose: 'captions', cost });
      words = r.words.filter((w) => w.end > w.start);
      transcript = r.text;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'caption ASR failed; rendering without captions');
    }
  }

  // ---- script fix: Hinglish must be Latin; Hindi must be Devanagari ----
  const target = cfg.caption_language === 'hinglish' ? 'latin' : cfg.caption_language === 'hi' ? 'devanagari' : null;
  if (target && words.some((w) => needsTransliteration(w.w, target))) {
    try {
      const out = await deps.providers.llm.transliterate(words.map((w) => w.w), target, cost);
      words = words.map((w, i) => ({ ...w, w: out[i] ?? w.w }));
      transcript = words.map((w) => w.w).join(' ');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'transliteration failed; keeping ASR script');
    }
  }

  // ---- titles (reuse on re-renders so the operator's options stay stable) ----
  let titles: TitleResult;
  if (prev?.titles?.length && job.reason !== 'initial') {
    titles = { titles: prev.titles, label: m.label ?? '' };
  } else {
    try {
      titles = await deps.providers.llm.titles(
        {
          language: cfg.caption_language,
          transcript: transcript || m.transcript || '',
          visionLabel: m.visionLabel,
          chatSample: m.chatSample,
          game: cfg.game ?? stream.game,
          creatorName: client.name,
        },
        cost,
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'title generation failed; using fallback titles');
      titles = fallbackTitles(m, client.name);
    }
  }
  const burned = job.titleOverride ?? prev?.chosenTitle ?? titles.titles[0];

  // ---- render ----
  const out = path.join(work, 'clip.mp4');
  const assPath = path.join(work, 'captions.ass');
  const layoutProbe = verticalRenderArgs({
    input: source,
    output: out,
    offsetS,
    durationS,
    preset: cfg.layout_preset,
    facecam: cfg.facecam_rect,
    focusX: cfg.gameplay_focus_x,
  });
  await fs.writeFile(
    assPath,
    buildAss({ words, language: cfg.caption_language, style: cfg.caption_style, title: burned, titleDurationS: 2, durationS, captionY: layoutProbe.captionY }),
  );
  const { args } = verticalRenderArgs({
    input: source,
    output: out,
    offsetS,
    durationS,
    preset: cfg.layout_preset,
    facecam: cfg.facecam_rect,
    focusX: cfg.gameplay_focus_x,
    assPath,
    fontsDir: deps.env.FONTS_DIR ?? null,
    x264Preset: deps.env.X264_PRESET,
  });
  const tRender = Date.now();
  await runProcess(deps.env.FFMPEG_BIN, args, { timeoutMs: 240_000 });
  deps.metrics.recordRender(Date.now() - tRender);
  const thumb = path.join(work, 'thumb.jpg');
  await runProcess(deps.env.FFMPEG_BIN, thumbnailArgs(out, Math.min(2.5, durationS / 2), thumb), { timeoutMs: 30_000 });

  // ---- upload + rows ----
  const clipKey = storageKeys.fastClip(client.id, m.id, version);
  const thumbKey = storageKeys.thumb(client.id, m.id, version);
  await Promise.all([deps.storage.put(clipKey, out, 'video/mp4'), deps.storage.put(thumbKey, thumb, 'image/jpeg')]);
  const renderMs = Date.now() - t0;
  const clip = await deps.db.insertClip({
    momentId: m.id,
    clientId: client.id,
    streamId: stream.id,
    kind: 'fast',
    r2Key: clipKey,
    thumbKey,
    sourceKey: m.source?.key ?? null,
    titles: titles.titles,
    chosenTitle: burned,
    burnedTitle: burned,
    language: cfg.caption_language,
    durationS,
    renderMs,
    startTs: m.startTs,
    endTs: m.endTs,
    needsReview: false,
  });
  const latest = await deps.db.getMoment(m.id);
  const keepStatus = latest && ['approved', 'delivered', 'premium', 'rejected'].includes(latest.status);
  await deps.db.updateMoment(m.id, {
    status: keepStatus ? latest!.status : 'proposed',
    transcript: transcript || m.transcript,
    label: titles.label || m.label,
  });
  await fs.rm(path.join(work, 'audio.wav'), { force: true });

  const clock = streamClocks.get(stream.id) ?? systemClock;
  const latencyMs = clock.now() - m.eventTs;
  if (job.reason === 'initial') deps.metrics.recordClipLatency(latencyMs);
  deps.metrics.inc('clips_rendered');
  log.info({ clipId: clip.id, version, renderMs, latencyS: Math.round(latencyMs / 1000), durationS: Math.round(durationS) }, 'fast clip ready');

  if (job.thenDeliver) await deps.deliverQueue.add({ clipId: clip.id }, { jobId: `deliver_${clip.id}` });
}
