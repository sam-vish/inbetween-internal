/**
 * Thin YouTube Data API v3 client. Every call is charged to the QuotaLedger
 * before it is made (PRD 4.10: "Count every YouTube API call").
 */
import type { QuotaLedger } from '@inbetween/shared';

const BASE = 'https://www.googleapis.com/youtube/v3';

export interface YtAuth {
  apiKey?: string;
  accessToken?: string;
}

export interface VideoItem {
  id: string;
  snippet?: { title?: string; channelId?: string; liveBroadcastContent?: 'live' | 'upcoming' | 'none' };
  liveStreamingDetails?: {
    actualStartTime?: string;
    actualEndTime?: string;
    scheduledStartTime?: string;
    activeLiveChatId?: string;
    concurrentViewers?: string;
  };
}

export interface LiveChatListResponse {
  nextPageToken?: string;
  pollingIntervalMillis?: number;
  offlineAt?: string;
  items: unknown[];
}

export class YouTubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'YouTubeApiError';
  }
}

export class YouTubeDataApi {
  constructor(
    private opts: { quota: QuotaLedger; apiKey?: string; fetchImpl?: typeof fetch; baseUrl?: string },
  ) {}

  private async get<T>(path: string, params: Record<string, string>, auth: YtAuth, method: string, streamId?: string | null) {
    await this.opts.quota.spend(method, { streamId });
    const qs = new URLSearchParams(params);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (auth.accessToken) headers.authorization = `Bearer ${auth.accessToken}`;
    else if (auth.apiKey ?? this.opts.apiKey) qs.set('key', (auth.apiKey ?? this.opts.apiKey)!);
    else throw new Error('YouTube API call needs YOUTUBE_API_KEY or an OAuth token');
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.opts.baseUrl ?? BASE}${path}?${qs}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status;
      throw new YouTubeApiError(res.status, reason, `${method} ${res.status} ${reason ?? ''} ${body?.error?.message ?? ''}`.trim());
    }
    return body as T;
  }

  /** videos.list (1 unit per call, up to 50 ids). */
  async videosList(ids: string[], auth: YtAuth = {}, streamId?: string | null): Promise<VideoItem[]> {
    if (!ids.length) return [];
    const body = await this.get<{ items?: VideoItem[] }>(
      '/videos',
      { part: 'snippet,liveStreamingDetails', id: ids.slice(0, 50).join(','), maxResults: '50' },
      auth,
      'videos.list',
      streamId,
    );
    return body.items ?? [];
  }

  /** liveChatMessages.list (5 units per poll). Fallback transport only. */
  async liveChatList(liveChatId: string, pageToken: string | undefined, auth: YtAuth = {}, streamId?: string | null) {
    const params: Record<string, string> = {
      liveChatId,
      part: 'id,snippet,authorDetails',
      maxResults: '2000',
    };
    if (pageToken) params.pageToken = pageToken;
    return this.get<LiveChatListResponse>('/liveChat/messages', params, auth, 'liveChatMessages.list', streamId);
  }

  /** channels.list?mine=true (1 unit). Used during OAuth onboarding to verify the channel. */
  async myChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
    const body = await this.get<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(
      '/channels',
      { part: 'snippet', mine: 'true' },
      { accessToken },
      'channels.list',
    );
    const ch = body.items?.[0];
    return ch ? { id: ch.id, title: ch.snippet?.title ?? '' } : null;
  }
}

/** Live = has started and has not ended. */
export function isVideoLive(v: VideoItem | undefined): boolean {
  const d = v?.liveStreamingDetails;
  return !!d?.actualStartTime && !d.actualEndTime;
}
