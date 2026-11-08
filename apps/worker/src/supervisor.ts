/**
 * Supervisor: the go-live loop. Every GO_LIVE_INTERVAL_S it probes each
 * active client's channel (no quota while offline), starts a StreamPipeline
 * per live broadcast, resumes the stream row after a worker restart, and
 * tears pipelines down when broadcasts end. WebSub pings trigger an
 * immediate probe for that channel.
 */
import {
  type ClientRecord,
  decryptSecret,
  isWithinActiveHours,
  type LiveSession,
  QuotaExceededError,
  systemClock,
} from '@inbetween/shared';
import type { WorkerDeps } from './deps';
import { StreamPipeline } from './pipeline/stream-pipeline';

export class Supervisor {
  private pipelines = new Map<string, StreamPipeline>(); // key: platform:videoId
  private timer: NodeJS.Timeout | null = null;
  private probing = false;
  private stopped = false;

  constructor(
    private deps: WorkerDeps,
    private opts: { maxStreams: number } = { maxStreams: 6 },
  ) {}

  get running() {
    return [...this.pipelines.values()];
  }

  async start() {
    await this.closeOrphanedStreams();
    this.timer = setInterval(() => void this.probeAll(), this.deps.env.GO_LIVE_INTERVAL_S * 1000);
    void this.probeAll();
  }

  /** Streams this host left 'live' after a crash are resumed by the next probe or closed if over. */
  private async closeOrphanedStreams() {
    const mine = await this.deps.db.listStreams({ status: 'live', workerHost: this.deps.host });
    if (mine.length) this.deps.log.info({ n: mine.length }, 'found live streams from a previous run; they resume on the next probe if still live');
    setTimeout(async () => {
      for (const s of mine) {
        if (![...this.pipelines.values()].some((p) => p.stream.id === s.id)) {
          await this.deps.db.updateStream(s.id, { status: 'ended', endedAt: Date.now() });
        }
      }
    }, this.deps.env.GO_LIVE_INTERVAL_S * 1000 * 2 + 10_000).unref();
  }

  async probeAll() {
    if (this.probing || this.stopped) return;
    this.probing = true;
    try {
      const clients = await this.deps.db.listActiveClients();
      for (const client of clients) {
        if (!isWithinActiveHours(client.config)) continue;
        await this.probeClient(client).catch((err) => {
          if (err instanceof QuotaExceededError) this.deps.log.error({ err: err.message }, 'quota exhausted during probe');
          else this.deps.log.warn({ client: client.name, err: (err as Error).message }, 'probe failed');
        });
      }
    } finally {
      this.probing = false;
    }
  }

  async probeChannel(channelId: string) {
    const clients = await this.deps.db.listActiveClients();
    for (const c of clients.filter((c) => c.youtubeChannelId === channelId)) await this.probeClient(c);
  }

  private refreshToken(client: ClientRecord): string | null {
    if (!client.oauthRefreshTokenEnc || !this.deps.env.OAUTH_ENCRYPTION_KEY) return null;
    try {
      return decryptSecret(client.oauthRefreshTokenEnc, this.deps.env.OAUTH_ENCRYPTION_KEY);
    } catch {
      return null;
    }
  }

  private async probeClient(client: ClientRecord) {
    const adapter = this.deps.adapters.get('youtube');
    const ref = { clientId: client.id, channelId: client.youtubeChannelId, oauthRefreshToken: this.refreshToken(client) };
    const sessions = adapter.detectAllLive ? await adapter.detectAllLive(ref) : [await adapter.detectLive(ref)].filter(Boolean) as LiveSession[];
    for (const s of sessions) {
      const key = `${s.platform}:${s.videoId}`;
      if (this.pipelines.has(key)) continue;
      if (this.pipelines.size >= this.opts.maxStreams) {
        void this.deps.alerter.alert(`capacity-${key}`, `${client.name} is live but this worker is at capacity (${this.opts.maxStreams} streams). Start another worker.`, { level: 'error' });
        continue;
      }
      await this.startPipeline(client, s);
    }
  }

  async startPipeline(client: ClientRecord, session: LiveSession) {
    const key = `${session.platform}:${session.videoId}`;
    const quotaMode = await this.deps.quota.mode();
    const chatMode = quotaMode === 'fallback' || quotaMode === 'exhausted' ? 'none' : 'stream';
    if (chatMode === 'none') {
      void this.deps.alerter.alert(`fallback-${key}`, `${client.name} went live while quota is at ${quotaMode}: running without API chat.`);
    }
    const existing = await this.deps.db.findLiveStream(client.id, session.videoId);
    const stream =
      existing ??
      (await this.deps.db.createStream({
        clientId: client.id,
        platform: session.platform,
        videoId: session.videoId,
        liveChatId: session.liveChatId,
        title: session.title,
        startedAt: session.startedAt,
        game: client.config.game,
        status: 'live',
        workerHost: this.deps.host,
      }));
    if (existing) await this.deps.db.updateStream(existing.id, { workerHost: this.deps.host, liveChatId: session.liveChatId });
    const p = new StreamPipeline(this.deps, this.deps.adapters.get(session.platform), client, session, stream, { chatMode, clock: systemClock });
    this.pipelines.set(key, p);
    this.deps.log.info({ client: client.name, video: session.videoId, resumed: !!existing }, 'client is live: starting pipeline');
    try {
      await p.start();
    } catch (err) {
      this.pipelines.delete(key);
      this.deps.log.error({ err: (err as Error).message }, 'pipeline failed to start');
      return;
    }
    void p.done.then((reason) => {
      this.pipelines.delete(key);
      this.deps.log.info({ client: client.name, video: session.videoId, reason }, 'pipeline finished');
    });
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.pipelines.values()].map((p) => p.stop('stopped')));
  }
}
