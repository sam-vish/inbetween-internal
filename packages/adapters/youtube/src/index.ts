/**
 * YouTube Live implementation of PlatformAdapter (v1's only platform).
 * Nothing outside packages/adapters/* imports this module directly — the
 * worker and dashboard go through @inbetween/adapters.
 */
import {
  type ChannelRef,
  type ChatOpenOptions,
  type Env,
  type LiveSession,
  type Logger,
  type PlatformAdapter,
  type QuotaLedger,
} from '@inbetween/shared';
import { isVideoLive, YouTubeDataApi } from './api';
import { readYouTubeChat, StreamListPool } from './chat';
import { readYouTubeCookies } from './cookies';
import { AccessTokenCache } from './oauth';
import { probeLivePage, probeStreamsTab, probeWithYtDlp } from './probe';
import { buildVideoSource } from './video';

export * from './api';
export * from './chat';
export * from './cookies';
export * from './normalize';
export * from './oauth';
export * from './probe';
export * from './recorded-chat';
export * from './video';

export interface YouTubeAdapterDeps {
  env: Env;
  quota: QuotaLedger;
  log: Logger;
  fetchImpl?: typeof fetch;
  pool?: StreamListPool;
}

export class YouTubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;
  readonly api: YouTubeDataApi;
  readonly tokens: AccessTokenCache;
  private pool: StreamListPool | null;
  private lastStreamsTab = new Map<string, number>();

  constructor(private deps: YouTubeAdapterDeps) {
    this.api = new YouTubeDataApi({ quota: deps.quota, apiKey: deps.env.YOUTUBE_API_KEY, fetchImpl: deps.fetchImpl });
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = deps.env;
    this.tokens = new AccessTokenCache(
      GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET } : null,
      deps.fetchImpl,
    );
    this.pool = deps.pool ?? null;
  }

  private getPool() {
    this.pool ??= new StreamListPool();
    return this.pool;
  }

  /** Confirms candidate video IDs with one videos.list call (1 unit). */
  private async confirm(channel: ChannelRef, ids: string[]): Promise<LiveSession[]> {
    const items = await this.api.videosList(ids);
    return items.filter(isVideoLive).map((v) => ({
      platform: 'youtube' as const,
      channelId: v.snippet?.channelId ?? channel.channelId,
      videoId: v.id,
      liveChatId: v.liveStreamingDetails?.activeLiveChatId ?? null,
      title: v.snippet?.title ?? null,
      startedAt: Date.parse(v.liveStreamingDetails!.actualStartTime!),
      url: `https://www.youtube.com/watch?v=${v.id}`,
    }));
  }

  async detectLive(channel: ChannelRef): Promise<LiveSession | null> {
    const env = this.deps.env;
    let probe = await probeLivePage(channel.channelId, { fetchImpl: this.deps.fetchImpl, cookiesFile: env.YOUTUBE_COOKIES_FILE });
    if (probe.via === 'none') {
      this.deps.log.debug({ channel: channel.channelId, err: probe.error }, 'live page probe failed; trying yt-dlp');
      probe = await probeWithYtDlp(channel.channelId, { bin: env.YTDLP_BIN, cookiesFile: env.YOUTUBE_COOKIES_FILE });
    }
    if (!probe.live || !probe.videoId) return null;
    const [session] = await this.confirm(channel, [probe.videoId]);
    return session ?? null;
  }

  /**
   * Primary broadcast from /live plus any other LIVE-badged videos on the
   * /streams tab (checked at most every STREAMS_TAB_INTERVAL_S per channel).
   */
  async detectAllLive(channel: ChannelRef): Promise<LiveSession[]> {
    const env = this.deps.env;
    const candidates = new Set<string>();
    const probe = await probeLivePage(channel.channelId, { fetchImpl: this.deps.fetchImpl, cookiesFile: env.YOUTUBE_COOKIES_FILE });
    if (probe.live && probe.videoId) candidates.add(probe.videoId);
    const last = this.lastStreamsTab.get(channel.channelId) ?? 0;
    if (probe.live && Date.now() - last > env.STREAMS_TAB_INTERVAL_S * 1000) {
      this.lastStreamsTab.set(channel.channelId, Date.now());
      try {
        for (const id of await probeStreamsTab(channel.channelId, { fetchImpl: this.deps.fetchImpl, cookiesFile: env.YOUTUBE_COOKIES_FILE })) {
          candidates.add(id);
        }
      } catch (err) {
        this.deps.log.debug({ err: (err as Error).message }, 'streams tab probe failed');
      }
    }
    if (!candidates.size) {
      if (probe.via === 'none') {
        const alt = await probeWithYtDlp(channel.channelId, { bin: env.YTDLP_BIN, cookiesFile: env.YOUTUBE_COOKIES_FILE });
        if (alt.live && alt.videoId) candidates.add(alt.videoId);
      }
      if (!candidates.size) return [];
    }
    return this.confirm(channel, [...candidates]);
  }

  async isStillLive(session: LiveSession): Promise<boolean> {
    const [item] = await this.api.videosList([session.videoId]);
    return isVideoLive(item);
  }

  openVideo(session: LiveSession) {
    const env = this.deps.env;
    return buildVideoSource(session, {
      resolver: env.HLS_RESOLVER,
      quality: env.HLS_QUALITY,
      streamlinkBin: env.STREAMLINK_BIN,
      ytdlpBin: env.YTDLP_BIN,
      cookiesFile: env.YOUTUBE_COOKIES_FILE,
      cookies: this.cookies,
    });
  }

  private cookies: Awaited<ReturnType<typeof readYouTubeCookies>> = [];

  /** Loads the cookies file (if any) so openVideo can pass them to streamlink. */
  async init() {
    if (this.deps.env.YOUTUBE_COOKIES_FILE) this.cookies = await readYouTubeCookies(this.deps.env.YOUTUBE_COOKIES_FILE);
  }

  openChat(session: LiveSession, opts: ChatOpenOptions) {
    return readYouTubeChat(session, opts, {
      quota: this.deps.quota,
      api: this.api,
      pool: this.getPool(),
      tokens: this.tokens,
      apiKey: this.deps.env.YOUTUBE_API_KEY,
      log: this.deps.log,
      pollMinMs: this.deps.env.CHAT_POLL_MIN_MS,
      streamId: opts.streamId,
    });
  }

  timestampUrl(session: LiveSession, offsetS: number) {
    return `https://www.youtube.com/watch?v=${session.videoId}&t=${Math.max(0, Math.floor(offsetS))}s`;
  }

  close() {
    this.pool?.close();
  }
}
