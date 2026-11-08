/**
 * One live session, end to end:
 *
 *   adapter.openVideo → IngestWorker → segments (RollingBuffer), PCM, frames
 *   adapter.openChat  → ChatSignalComputer ─┐
 *   PCM → AudioLoudnessMeter ───────────────┤ (EWMA z) → SignalBus → MomentScorer
 *   PCM → VoiceProducer (live ASR) ─────────┤                         │
 *   frames → VisionProducer (Gemini) ───────┘                         ▼
 *                                                   Clipper → render queue → clip
 *
 * Also persists chat_events (author hashed) and one signal_samples row per
 * second, snapshots the channel baseline, and handles drops/end of stream.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type BusEvent,
  type ChatEvent,
  type ChatEventRow,
  type ChatTransportStatus,
  type ClientRecord,
  type Clock,
  decryptSecret,
  hashAuthor,
  type LiveSession,
  type Logger,
  type PlatformAdapter,
  type SignalName,
  type SignalSampleRow,
  sleep,
  storageKeys,
  type StreamRecord,
} from '@inbetween/shared';
import { AudioLoudnessMeter, ChatSignalComputer, MomentScorer, SignalNormalizer } from '@inbetween/signals';
import { Clipper } from '../clipper/clipper';
import type { WorkerDeps } from '../deps';
import { RollingBuffer } from '../ingest/buffer';
import { IngestWorker } from '../ingest/ingest';
import { VisionProducer } from '../producers/vision';
import { VoiceProducer } from '../producers/voice';
import { streamClocks } from '../render/fast-lane';
import { buildStreamSummary, sendStreamSummary } from '../summary';

export interface PipelineOptions {
  chatMode: 'stream' | 'poll' | 'none';
  clock: Clock;
  /** Replay: end when the file ends instead of reconnecting. */
  endOnSourceEnd?: boolean;
  /** Seconds to keep in the rolling buffer. */
  bufferRetentionS?: number;
}

type EndReason = 'ended' | 'stopped' | 'error';

export class StreamPipeline {
  readonly log: Logger;
  readonly buffer: RollingBuffer;
  private ingest!: IngestWorker;
  private meter = new AudioLoudnessMeter();
  private meterSession = 0;
  private meterAnchor = 0;
  private normalizer: SignalNormalizer;
  private chat: ChatSignalComputer;
  private scorer: MomentScorer;
  private voice: VoiceProducer;
  private vision: VisionProducer;
  private clipper: Clipper;
  private abort = new AbortController();
  private timers: NodeJS.Timeout[] = [];
  private unsubBus: (() => void) | null = null;
  private unregisterMetrics: (() => void) | null = null;
  private chatRows: ChatEventRow[] = [];
  private sigRows: SignalSampleRow[] = [];
  private recentChat: Array<{ ts: number; text: string }> = [];
  private chatSealDelayS = 3;
  private stopping = false;
  private endResolve!: (r: EndReason) => void;
  readonly done: Promise<EndReason>;
  private lastLiveCheck = 0;
  private consecutiveDrops = 0;
  private chatEnded = false;
  private chatStatus: ChatTransportStatus | null = null;
  readonly dir: string;

  constructor(
    private deps: WorkerDeps,
    private adapter: PlatformAdapter,
    private client: ClientRecord,
    readonly session: LiveSession,
    readonly stream: StreamRecord,
    private opts: PipelineOptions,
  ) {
    this.log = deps.log.child({ stream: stream.id, client: client.name, video: session.videoId });
    this.dir = path.join(deps.dataDir, 'streams', stream.id);
    this.done = new Promise((r) => (this.endResolve = r));
    const cfg = client.config;
    this.buffer = new RollingBuffer((opts.bufferRetentionS ?? 300) * 1000);
    this.normalizer = new SignalNormalizer(cfg.baseline.window_s, cfg.baseline.min_samples, client.baseline);
    this.chat = new ChatSignalComputer(cfg);
    const cost = deps.costs.reporter({ clientId: client.id, streamId: stream.id });
    this.scorer = new MomentScorer(stream.id, cfg, {
      onMoment: (m) => this.clipper.handleMoment(m),
      onExtend: (m) => this.clipper.handleExtend(m),
      onSuppressed: (m, why) => this.log.info({ score: m.score, why }, 'moment suppressed'),
      onRow: (r) => this.sigRows.push(r),
      onBurst: (until) => this.vision.burst(until),
    });
    this.voice = new VoiceProducer(cfg, deps.providers.liveAsr, (r) => {
      for (const { sec, hits } of r.perSecond) this.publishSample('voice_hype', sec, hits);
    }, this.log, cost);
    this.vision = new VisionProducer(
      cfg,
      deps.providers.vision,
      opts.clock,
      () => this.ingest?.latestFrame() ?? null,
      (frame, r) =>
        this.publish({
          type: 'sample',
          sample: { streamId: stream.id, signal: 'vision_event', sec: Math.floor(frame.ts / 1000), raw: r.confidence, z: r.confidence, label: r.event, detail: r.detail },
        }),
      () => deps.costs.isCapped(stream.id),
      this.log,
      cost,
    );
    this.clipper = new Clipper({
      deps,
      client,
      stream,
      buffer: this.buffer,
      clock: opts.clock,
      log: this.log,
      chatSample: (from, to) => this.chatSample(from, to),
      transcriptAround: (from, to) => this.voice.transcriptAround(from, to),
      isStopping: () => this.stopping && this.abort.signal.aborted,
    });
    deps.costs.setCap(stream.id, cfg.cost_cap_usd);
  }

  private publish(ev: BusEvent) {
    this.deps.bus.publish(this.stream.id, ev);
  }

  private publishSample(signal: SignalName, sec: number, raw: number) {
    const z = this.normalizer.observe(signal, raw);
    this.publish({ type: 'sample', sample: { streamId: this.stream.id, signal, sec, raw, z } });
  }

  private chatSample(fromTs: number, toTs: number): string[] {
    const msgs = this.recentChat.filter((m) => m.ts >= fromTs && m.ts <= toTs && m.text.trim());
    const counts = new Map<string, number>();
    for (const m of msgs) counts.set(m.text.trim(), (counts.get(m.text.trim()) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([t, n]) => (n > 1 ? `${t} (×${n})` : t));
  }

  async start() {
    const { deps, client, stream, opts } = this;
    streamClocks.set(stream.id, opts.clock);
    await fs.mkdir(this.dir, { recursive: true });

    // Bus → scorer (also works when signal workers run in another process).
    this.unsubBus = deps.bus.subscribe(stream.id, (ev) => {
      if (ev.type === 'sample') this.scorer.ingest(ev.sample);
      else if (ev.type === 'paid') this.scorer.ingestPaid(ev.ts);
    });

    // Video
    this.ingest = new IngestWorker({
      source: this.adapter.openVideo(this.session),
      dir: this.dir,
      clock: opts.clock,
      buffer: this.buffer,
      ffmpegBin: deps.env.FFMPEG_BIN,
      log: this.log.child({ mod: 'ingest' }),
      videoOffsetS: client.config.timing.video_offset_s,
    });
    this.ingest.on('audio', (chunk, anchorTs, session) => this.onAudio(chunk, anchorTs, session));
    this.ingest.on('drop', (info) => void this.onDrop(info));
    this.ingest.on('ended', () => {
      if (opts.endOnSourceEnd) void this.stop('ended');
    });
    await this.ingest.start();

    // Chat
    void this.chatLoop();

    // Timers
    this.every(1000, () => this.tick());
    this.every(5000, () => void this.flushChat());
    this.every(10_000, () => void this.flushSignals());
    this.every(30_000, () => void this.uploadLatestFrame());
    this.every(300_000, () => void this.saveBaseline());

    this.unregisterMetrics = deps.metrics.registerStream(stream.id, () => this.status());
    this.log.info({ chatMode: opts.chatMode, startedAt: new Date(this.session.startedAt).toISOString() }, 'pipeline started');
  }

  private every(ms: number, f: () => void) {
    const t = setInterval(() => {
      try {
        f();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'pipeline timer error');
      }
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  private onAudio(chunk: Buffer, anchorTs: number, session: number) {
    if (session !== this.meterSession) {
      this.meterSession = session;
      this.meterAnchor = anchorTs;
      this.meter = new AudioLoudnessMeter();
      this.voice.reset();
    }
    const chunkTs = this.meterAnchor + this.meter.mediaSeconds * 1000;
    for (const { index, db } of this.meter.push(chunk)) {
      this.publishSample('audio_loud', Math.floor((this.meterAnchor + index * 1000) / 1000), db);
    }
    this.voice.push(chunk, chunkTs);
  }

  private tick() {
    const now = this.opts.clock.now();
    // Seal chat seconds (zeros for silent ones) once late messages are unlikely.
    if (this.opts.chatMode !== 'none' && !this.chatEnded) {
      for (const v of this.chat.sealUpTo(Math.floor(now / 1000) - this.chatSealDelayS)) {
        this.publishSample('chat_rate', v.sec, v.chat_rate);
        this.publishSample('chat_reaction', v.sec, v.chat_reaction);
        this.publishSample('chat_caps', v.sec, v.chat_caps);
      }
    }
    this.scorer.tick(now);
    this.vision.tick();
    void this.buffer.evict(now);
    const cutoff = now - 120_000;
    while (this.recentChat.length && this.recentChat[0].ts < cutoff) this.recentChat.shift();
  }

  private async chatLoop() {
    const { deps, client, stream, opts } = this;
    if (opts.chatMode === 'none') {
      this.log.warn('chat disabled for this stream (fallback mode)');
      return;
    }
    let refresh: string | null = null;
    if (client.oauthRefreshTokenEnc && deps.env.OAUTH_ENCRYPTION_KEY) {
      try {
        refresh = decryptSecret(client.oauthRefreshTokenEnc, deps.env.OAUTH_ENCRYPTION_KEY);
      } catch {
        this.log.warn('could not decrypt client OAuth token');
      }
    }
    const salt = deps.env.AUTHOR_HASH_SALT;
    try {
      for await (const ev of this.adapter.openChat(this.session, {
        signal: this.abort.signal,
        mode: opts.chatMode,
        oauthRefreshToken: refresh,
        preferOAuth: client.config.chat_auth === 'oauth',
        streamId: stream.id,
        onStatus: (s) => this.onChatStatus(s),
      })) {
        this.onChat(ev, salt);
      }
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'chat loop crashed');
    }
    this.chatEnded = true;
    if (!this.stopping) await this.checkStillLive('chat ended');
  }

  private onChatStatus(s: ChatTransportStatus) {
    this.chatStatus = s;
    if (s.expectedDelayMs) {
      this.chatSealDelayS = Math.ceil(s.expectedDelayMs / 1000) + 1;
      // The scorer must wait at least as long as the slowest signal.
      this.scorer.delayS = Math.max(this.client.config.timing.scorer_delay_s, this.chatSealDelayS + 3);
    }
    const level = s.state === 'error' || s.state === 'fallback' ? 'warn' : 'info';
    this.log[level]({ chat: s }, 'chat transport');
    if (s.state === 'fallback' || s.state === 'error') {
      void this.deps.alerter.alert(`chat-${this.stream.id}-${s.state}`, `${this.client.name}: chat ${s.state} — ${s.detail ?? ''}`);
    }
  }

  private onChat(ev: ChatEvent, salt: string) {
    this.chatRows.push({
      streamId: this.stream.id,
      ts: ev.ts,
      authorHash: hashAuthor(ev.authorId || ev.authorName, salt),
      text: ev.text.slice(0, 500),
      isPaid: ev.isPaid,
      amount: ev.amount,
      currency: ev.currency,
      kind: ev.kind,
    });
    if (ev.isPaid) this.publish({ type: 'paid', streamId: this.stream.id, ts: ev.ts, amount: ev.amount, currency: ev.currency ?? undefined, kind: ev.kind });
    if (this.chat.push(ev)) this.recentChat.push({ ts: ev.ts, text: ev.text });
  }

  private async onDrop(info: { session: number; code: number | null; stderr: string; ranMs: number }) {
    if (this.stopping) return;
    this.consecutiveDrops = info.ranMs > 60_000 ? 1 : this.consecutiveDrops + 1;
    this.log.warn({ ...info, stderr: info.stderr.slice(-300), drops: this.consecutiveDrops }, 'ingest dropped');
    if (this.opts.endOnSourceEnd) return void this.stop('ended');
    if (this.consecutiveDrops >= 2 && (await this.checkStillLive('ingest drop'))) return;
    if (this.stopping) return;
    const wait = Math.min(30_000, 1000 * 2 ** Math.min(this.consecutiveDrops, 5));
    await sleep(wait, this.abort.signal);
    if (!this.stopping) this.ingest.restart();
  }

  /** Returns true if the stream was found to have ended (and the pipeline is stopping). */
  private async checkStillLive(why: string): Promise<boolean> {
    if (!this.adapter.isStillLive) return false;
    if (Date.now() - this.lastLiveCheck < 120_000) return false;
    this.lastLiveCheck = Date.now();
    try {
      const live = await this.adapter.isStillLive(this.session);
      if (!live) {
        this.log.info({ why }, 'broadcast has ended');
        void this.stop('ended');
        return true;
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'isStillLive check failed');
    }
    return false;
  }

  private async flushChat() {
    if (!this.chatRows.length) return;
    const rows = this.chatRows.splice(0);
    try {
      await this.deps.db.insertChatEvents(rows);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'chat_events insert failed');
      if (this.chatRows.length < 20_000) this.chatRows.unshift(...rows);
    }
  }

  private async flushSignals() {
    if (!this.sigRows.length) return;
    const rows = this.sigRows.splice(0);
    try {
      await this.deps.db.insertSignalSamples(rows);
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'signal_samples insert failed');
      if (this.sigRows.length < 20_000) this.sigRows.unshift(...rows);
    }
  }

  private async uploadLatestFrame() {
    const f = this.ingest?.latestFrame();
    if (!f) return;
    try {
      await this.deps.storage.put(storageKeys.liveFrame(this.stream.id), f.path, 'image/jpeg');
    } catch {
      /* best effort */
    }
  }

  private async saveBaseline() {
    try {
      await this.deps.db.updateClient(this.client.id, { baseline: this.normalizer.snapshot() });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'baseline save failed');
    }
  }

  status() {
    return {
      client: this.client.name,
      video: this.session.videoId,
      buffer: { segments: this.buffer.size, gaps: this.buffer.gaps.length, latestTs: this.buffer.latestTs },
      ingest: this.ingest?.stats,
      chat: { transport: this.chatStatus, dropped: this.chat.dropped },
      scorer: { lateSamples: this.scorer.lateSamples, moments: this.scorer.emittedMoments.length, delayS: this.scorer.delayS },
      voice: this.voice.stats,
      vision: { ...this.vision.stats, burst: this.vision.inBurst },
      clipper: this.clipper.stats,
      costUsd: Math.round(this.deps.costs.streamTotal(this.stream.id) * 10000) / 10000,
      quotaUnits: this.deps.quota.streamUnits(this.stream.id),
    };
  }

  async stop(reason: EndReason = 'stopped') {
    if (this.stopping) return this.done;
    this.stopping = true;
    this.log.info({ reason }, 'pipeline stopping');
    this.abort.abort();
    for (const t of this.timers) clearInterval(t);
    await this.ingest?.stop();
    // Evaluate the remaining seconds and close any open moment.
    if (this.opts.chatMode !== 'none') {
      const last = this.buffer.latestTs ?? this.opts.clock.now();
      for (const v of this.chat.sealUpTo(Math.floor(last / 1000))) {
        this.publishSample('chat_rate', v.sec, v.chat_rate);
        this.publishSample('chat_reaction', v.sec, v.chat_reaction);
        this.publishSample('chat_caps', v.sec, v.chat_caps);
      }
    }
    await sleep(300); // let bus deliveries land (Redis bus batches every 100ms)
    this.scorer.flush();
    await this.clipper.drain();
    this.unsubBus?.();
    await Promise.allSettled([this.flushChat(), this.flushSignals(), this.saveBaseline()]);

    if (reason === 'ended') {
      const endedAt = this.buffer.latestTs ?? this.opts.clock.now();
      const summary = await buildStreamSummary(this.deps, this.stream, endedAt);
      await this.deps.db.updateStream(this.stream.id, { status: 'ended', endedAt, summary });
      await sendStreamSummary(this.deps, this.client, summary);
      this.log.info({ summary }, 'stream ended');
    }
    await this.buffer.clear();
    await this.ingest?.removeFrames();
    await fs.rm(path.join(this.dir, 'seg'), { recursive: true, force: true });
    this.unregisterMetrics?.();
    this.endResolve(reason);
    return this.done;
  }
}
