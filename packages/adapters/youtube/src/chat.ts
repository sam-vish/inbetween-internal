/**
 * Live chat transport (PRD 4.3).
 *
 * Primary: liveChatMessages.streamList — gRPC server-streaming at
 * youtube.googleapis.com:443, 5 quota units per connection, accepts an API
 * key (x-goog-api-key) or an OAuth bearer token. Reconnects resume from the
 * last nextPageToken, and only happen when the stream actually drops.
 *
 * Fallback: liveChatMessages.list polling (5 units per poll), honoring
 * pollingIntervalMillis with a floor (CHAT_POLL_MIN_MS) to protect quota.
 */
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {
  backoffMs,
  type ChatEvent,
  type ChatOpenOptions,
  type LiveSession,
  type Logger,
  QuotaExceededError,
  type QuotaLedger,
  sleep,
} from '@inbetween/shared';
import { type YouTubeDataApi, YouTubeApiError } from './api';
import { isChatEndedMessage, normalizeYouTubeMessage } from './normalize';
import type { AccessTokenCache } from './oauth';

const PROTO_PATH = fileURLToPath(new URL('../proto/stream_list.proto', import.meta.url));

let serviceCtor: grpc.ServiceClientConstructor | null = null;
export function loadStreamListService(): grpc.ServiceClientConstructor {
  if (!serviceCtor) {
    const def = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false,
      longs: String,
      enums: String,
      defaults: false,
      oneofs: true,
    });
    const pkg = grpc.loadPackageDefinition(def) as any;
    serviceCtor = pkg.youtube.api.v3.V3DataLiveChatMessageService as grpc.ServiceClientConstructor;
  }
  return serviceCtor;
}

/**
 * Round-robin pool of gRPC channels. YouTube's streaming guide recommends
 * channel pooling because HTTP/2 caps concurrent streams per connection.
 */
export class StreamListPool {
  private clients: grpc.Client[] = [];
  private i = 0;
  constructor(
    target = 'youtube.googleapis.com:443',
    size = 2,
    creds: grpc.ChannelCredentials = grpc.credentials.createSsl(),
  ) {
    const Ctor = loadStreamListService();
    for (let n = 0; n < Math.max(1, size); n++) {
      this.clients.push(new Ctor(target, creds, { 'grpc.keepalive_time_ms': 30_000, 'grpc.keepalive_timeout_ms': 10_000 }));
    }
  }
  next(): any {
    const c = this.clients[this.i % this.clients.length];
    this.i++;
    return c;
  }
  close() {
    for (const c of this.clients) c.close();
  }
}

export interface ChatReaderDeps {
  quota: QuotaLedger;
  api: YouTubeDataApi;
  pool: StreamListPool;
  tokens: AccessTokenCache;
  apiKey?: string;
  log: Logger;
  pollMinMs: number;
  streamId?: string | null;
}

class Seen {
  private set = new Set<string>();
  private order: string[] = [];
  constructor(private max = 20_000) {}
  add(id: string): boolean {
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.order.push(id);
    if (this.order.length > this.max) this.set.delete(this.order.shift()!);
    return true;
  }
}

type AuthMode = 'api_key' | 'oauth';

async function authMetadata(mode: AuthMode, deps: ChatReaderDeps, refreshToken?: string | null) {
  const md = new grpc.Metadata();
  if (mode === 'oauth') {
    if (!refreshToken) throw new Error('oauth chat auth requested but client has no refresh token');
    md.set('authorization', `Bearer ${await deps.tokens.get(refreshToken)}`);
  } else {
    if (!deps.apiKey) throw new Error('YOUTUBE_API_KEY not configured');
    md.set('x-goog-api-key', deps.apiKey);
  }
  return md;
}

function pickAuth(opts: ChatOpenOptions, deps: ChatReaderDeps): AuthMode {
  const canOAuth = !!opts.oauthRefreshToken && deps.tokens.enabled;
  if (opts.preferOAuth && canOAuth) return 'oauth';
  if (deps.apiKey) return 'api_key';
  if (canOAuth) return 'oauth';
  throw new Error('no chat credentials: set YOUTUBE_API_KEY or connect the client via OAuth');
}

export async function* readYouTubeChat(
  session: LiveSession,
  opts: ChatOpenOptions,
  deps: ChatReaderDeps,
): AsyncGenerator<ChatEvent> {
  if (opts.mode === 'none' || !session.liveChatId) {
    opts.onStatus?.({ transport: 'none', state: 'ended', detail: session.liveChatId ? 'chat disabled by mode' : 'no live chat id' });
    return;
  }
  const seen = new Seen();
  let auth = pickAuth(opts, deps);
  let pageToken: string | undefined;
  let mode = opts.mode;

  // ---- server-streaming ----
  if (mode === 'stream') {
    let failures = 0;
    while (!opts.signal.aborted) {
      try {
        await deps.quota.spend('liveChatMessages.streamList', { streamId: deps.streamId });
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          opts.onStatus?.({ transport: 'stream', state: 'error', detail: err.message });
          return;
        }
        throw err;
      }
      opts.onStatus?.({ transport: 'stream', state: failures ? 'reconnecting' : 'connecting', expectedDelayMs: 1500 });
      let gotData = false;
      try {
        const md = await authMetadata(auth, deps, opts.oauthRefreshToken);
        const client = deps.pool.next();
        const call = client.StreamList(
          { liveChatId: session.liveChatId, part: ['id', 'snippet', 'authorDetails'], pageToken, profileImageSize: 16 },
          md,
        ) as grpc.ClientReadableStream<any>;
        const onAbort = () => call.cancel();
        opts.signal.addEventListener('abort', onAbort, { once: true });
        try {
          for await (const resp of call) {
            if (!gotData) {
              gotData = true;
              opts.onStatus?.({ transport: 'stream', state: 'connected', expectedDelayMs: 1500 });
            }
            failures = 0;
            if (resp.nextPageToken) pageToken = resp.nextPageToken;
            for (const item of resp.items ?? []) {
              if (isChatEndedMessage(item)) {
                opts.onStatus?.({ transport: 'stream', state: 'ended', detail: 'chat ended event' });
                return;
              }
              const ev = normalizeYouTubeMessage(item);
              if (ev && seen.add(ev.id)) yield ev;
            }
            if (resp.offlineAt) {
              opts.onStatus?.({ transport: 'stream', state: 'ended', detail: `offline at ${resp.offlineAt}` });
              return;
            }
          }
        } finally {
          opts.signal.removeEventListener('abort', onAbort);
        }
        // Server closed the stream cleanly: resume from pageToken (costs another connection).
        if (opts.signal.aborted) return;
        deps.log.info({ liveChatId: session.liveChatId }, 'streamList closed by server; resuming');
        await sleep(gotData ? 500 : backoffMs(failures++, 1000, 30_000), opts.signal);
      } catch (err: any) {
        if (opts.signal.aborted) return;
        const code: number | undefined = err?.code;
        const msg = String(err?.details ?? err?.message ?? err);
        deps.log.warn({ code, msg, failures }, 'streamList error');
        if (code === grpc.status.FAILED_PRECONDITION || code === grpc.status.NOT_FOUND) {
          // LIVE_CHAT_ENDED / LIVE_CHAT_DISABLED (indistinguishable over gRPC) or chat not found.
          opts.onStatus?.({ transport: 'stream', state: 'ended', detail: msg });
          return;
        }
        if (code === grpc.status.PERMISSION_DENIED || code === grpc.status.UNAUTHENTICATED) {
          if (auth === 'api_key' && opts.oauthRefreshToken && deps.tokens.enabled) {
            auth = 'oauth';
            continue;
          }
          opts.onStatus?.({ transport: 'stream', state: 'error', detail: `permission denied: ${msg}` });
          return;
        }
        failures++;
        if (code === grpc.status.RESOURCE_EXHAUSTED) {
          await sleep(Math.max(10_000, backoffMs(failures, 5000, 60_000)), opts.signal);
          continue;
        }
        if (failures >= 6 && opts.mode === 'stream') {
          opts.onStatus?.({ transport: 'poll', state: 'fallback', detail: `streamList failed ${failures}x: ${msg}` });
          mode = 'poll';
          break;
        }
        await sleep(backoffMs(failures, 1000, 30_000), opts.signal);
      }
    }
  }

  // ---- polling fallback ----
  if (mode === 'poll') {
    let failures = 0;
    opts.onStatus?.({ transport: 'poll', state: 'connecting', expectedDelayMs: deps.pollMinMs + 1500 });
    while (!opts.signal.aborted) {
      let waitMs = deps.pollMinMs;
      try {
        const yauth = auth === 'oauth' && opts.oauthRefreshToken
          ? { accessToken: await deps.tokens.get(opts.oauthRefreshToken) }
          : { apiKey: deps.apiKey };
        const resp = await deps.api.liveChatList(session.liveChatId, pageToken, yauth, deps.streamId);
        failures = 0;
        if (resp.nextPageToken) pageToken = resp.nextPageToken;
        for (const item of resp.items ?? []) {
          if (isChatEndedMessage(item)) {
            opts.onStatus?.({ transport: 'poll', state: 'ended', detail: 'chat ended event' });
            return;
          }
          const ev = normalizeYouTubeMessage(item);
          if (ev && seen.add(ev.id)) yield ev;
        }
        if (resp.offlineAt) {
          opts.onStatus?.({ transport: 'poll', state: 'ended', detail: `offline at ${resp.offlineAt}` });
          return;
        }
        waitMs = Math.max(resp.pollingIntervalMillis ?? 0, deps.pollMinMs);
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          opts.onStatus?.({ transport: 'poll', state: 'error', detail: err.message });
          return;
        }
        if (err instanceof YouTubeApiError) {
          if (err.reason === 'liveChatEnded' || err.reason === 'liveChatDisabled' || err.reason === 'liveChatNotFound') {
            opts.onStatus?.({ transport: 'poll', state: 'ended', detail: err.reason });
            return;
          }
          if (err.status === 403 && err.reason === 'forbidden') {
            opts.onStatus?.({ transport: 'poll', state: 'error', detail: err.message });
            return;
          }
        }
        failures++;
        deps.log.warn({ err: (err as Error).message, failures }, 'chat poll error');
        waitMs = backoffMs(failures, Math.max(deps.pollMinMs, 5000), 120_000);
      }
      await sleep(waitMs, opts.signal);
    }
  }
}
