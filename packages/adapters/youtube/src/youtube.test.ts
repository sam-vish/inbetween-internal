import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { MemoryDb, QuotaLedger, getLogger, type ChatEvent, type ChatTransportStatus, type LiveSession } from '@inbetween/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { YouTubeDataApi } from './api';
import { loadStreamListService, readYouTubeChat, StreamListPool } from './chat';
import { parseCookiesTxt, streamlinkCookieArgs } from './cookies';
import { normalizeYouTubeMessage } from './normalize';
import { AccessTokenCache, buildConsentUrl } from './oauth';
import { parseLivePage, parseStreamsTab } from './probe';
import { parseYtDlpLiveChat } from './recorded-chat';
import { buildVideoSource } from './video';

const fx = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8');
const log = getLogger('test');

describe('live page probe parser', () => {
  it('detects a live broadcast and its video id', () => {
    expect(parseLivePage(fx('live-page.html'))).toEqual({ live: true, videoId: '4t4AQ15yj1M', upcoming: false });
  });
  it('reports offline channels', () => {
    expect(parseLivePage(fx('offline-page.html'))).toEqual({ live: false, videoId: null, upcoming: false });
  });
  it('treats scheduled broadcasts as not live', () => {
    expect(parseLivePage(fx('upcoming-page.html'))).toEqual({ live: false, videoId: 'AbCdEfGhIjK', upcoming: true });
  });
  it('finds every LIVE-badged video on the streams tab', () => {
    expect(parseStreamsTab(fx('streams-tab.html')).sort()).toEqual(['4t4AQ15yj1M', 'Second_Live'].sort());
  });
});

describe('chat normalization', () => {
  it('maps gRPC (proto-loader) shaped super chats', () => {
    const ev = normalizeYouTubeMessage({
      id: 'abc',
      snippet: {
        type: 'SUPER_CHAT_EVENT',
        publishedAt: '2026-11-19T14:00:00.000Z',
        superChatDetails: { amountMicros: '100000000', currency: 'INR', amountDisplayString: '₹100.00', userComment: 'bhai OP' },
      },
      authorDetails: { channelId: 'UC1', displayName: 'fan', isChatSponsor: true },
    })!;
    expect(ev).toMatchObject({ kind: 'paid_message', isPaid: true, amount: 100, currency: 'INR', text: 'bhai OP', isMember: true });
    expect(ev.ts).toBe(Date.parse('2026-11-19T14:00:00.000Z'));
  });
  it('maps REST shaped text messages and skips tombstones', () => {
    const ev = normalizeYouTubeMessage({
      id: 'x1',
      snippet: { type: 'textMessageEvent', publishedAt: '2026-11-19T14:00:01Z', textMessageDetails: { messageText: 'LMAO 💀' } },
      authorDetails: { channelId: 'UC2', displayName: 'v' },
    })!;
    expect(ev).toMatchObject({ kind: 'text', isPaid: false, text: 'LMAO 💀', amount: 0 });
    expect(normalizeYouTubeMessage({ id: 't', snippet: { type: 'tombstone' } })).toBeNull();
  });
  it('treats memberships and gifting as paid events', () => {
    expect(normalizeYouTubeMessage({ id: 'm', snippet: { type: 'newSponsorEvent', displayMessage: 'Welcome!' } })?.isPaid).toBe(true);
    expect(
      normalizeYouTubeMessage({ id: 'g', snippet: { type: 'MEMBERSHIP_GIFTING_EVENT', membershipGiftingDetails: { giftMembershipsCount: 5 } } }),
    ).toMatchObject({ kind: 'membership_gift', amount: 5 });
  });
});

describe('recorded chat (yt-dlp live_chat.json)', () => {
  it('parses text, emoji shortcuts and paid messages with VOD offsets', () => {
    const evs = parseYtDlpLiveChat(fx('live_chat.json'));
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ ts: 12500, text: 'bhai kya kar diya 😂:_bhaiHype:', isPaid: false, authorName: 'viewer1' });
    expect(evs[1]).toMatchObject({ ts: 14000, isPaid: true, amount: 500, currency: '₹', text: 'GG bro' });
  });
});

describe('video source + cookies + oauth', () => {
  const session: LiveSession = {
    platform: 'youtube',
    channelId: 'UC1',
    videoId: 'vid12345678',
    liveChatId: 'chat',
    title: null,
    startedAt: 0,
    url: 'https://www.youtube.com/watch?v=vid12345678',
  };
  it('builds a streamlink command preferring 720p60', () => {
    const src = buildVideoSource(session, { resolver: 'streamlink', quality: '720p60,720p,best', streamlinkBin: 'streamlink', ytdlpBin: 'yt-dlp' });
    expect(src.kind).toBe('command');
    if (src.kind === 'command') {
      expect(src.args).toContain('--stdout');
      expect(src.args.slice(-2)).toEqual([session.url, '720p60,720p,best']);
    }
  });
  it('builds a yt-dlp format selector', () => {
    const src = buildVideoSource(session, { resolver: 'ytdlp', quality: '720p60,720p,best', streamlinkBin: 'streamlink', ytdlpBin: 'yt-dlp' });
    if (src.kind === 'command') expect(src.args).toContain('best[height<=720][fps>=60]/best[height<=720]/best');
  });
  it('parses cookies.txt into streamlink args', () => {
    const cookies = parseCookiesTxt('# Netscape\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tabc\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tHSID\tdef\n');
    expect(streamlinkCookieArgs(cookies)).toEqual(['--http-cookie', 'SID=abc', '--http-cookie', 'HSID=def']);
  });
  it('builds an offline, read-only consent URL', () => {
    const url = new URL(buildConsentUrl({ clientId: 'cid', clientSecret: 's', redirectUri: 'https://x/cb' }, 'st'));
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/youtube.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('st');
  });
});

// ---------------- streamList against a local fake gRPC server ----------------

describe('streamList transport (fake gRPC server)', () => {
  let server: grpc.Server;
  let port = 0;
  const calls: Array<{ pageToken?: string; apiKey?: string }> = [];
  let scenario: 'drop-then-end' | 'permission' = 'drop-then-end';

  const msg = (id: string, text: string, sec: number) => ({
    id,
    snippet: { type: 'TEXT_MESSAGE_EVENT', publishedAt: new Date(Date.UTC(2026, 10, 19, 14, 0, sec)).toISOString(), textMessageDetails: { messageText: text } },
    authorDetails: { channelId: `UC${id}`, displayName: `user${id}` },
  });

  beforeAll(async () => {
    const Svc = loadStreamListService();
    server = new grpc.Server();
    server.addService(Svc.service, {
      StreamList: (call: grpc.ServerWritableStream<any, any>) => {
        calls.push({ pageToken: call.request.pageToken, apiKey: call.metadata.get('x-goog-api-key')[0] as string });
        if (scenario === 'permission') {
          call.emit('error', { code: grpc.status.PERMISSION_DENIED, details: 'The caller does not have permission' });
          return;
        }
        if (!call.request.pageToken) {
          // First connection: two messages, then the server drops the stream.
          call.write({ nextPageToken: 'tok1', items: [msg('1', 'no way', 1), msg('2', 'LOL', 2)] });
          call.end();
        } else {
          // Resumed connection: a duplicate (must be deduped), a new message, then offline.
          call.write({ nextPageToken: 'tok2', items: [msg('2', 'LOL', 2), msg('3', 'GG', 3)] });
          call.write({ nextPageToken: 'tok3', items: [], offlineAt: '2026-11-19T15:00:00Z' });
          call.end();
        }
      },
    });
    port = await new Promise<number>((res, rej) =>
      server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? rej(err) : res(p))),
    );
  });
  afterAll(() => server.forceShutdown());

  const session: LiveSession = {
    platform: 'youtube',
    channelId: 'UC1',
    videoId: 'vid12345678',
    liveChatId: 'live-chat-1',
    title: null,
    startedAt: 0,
    url: '',
  };

  it('resumes from nextPageToken after a drop, dedupes, stops at offlineAt and counts quota', async () => {
    scenario = 'drop-then-end';
    calls.length = 0;
    const db = new MemoryDb();
    const quota = new QuotaLedger({ db, dailyLimit: 10_000 });
    const pool = new StreamListPool(`127.0.0.1:${port}`, 1, grpc.credentials.createInsecure());
    const statuses: ChatTransportStatus[] = [];
    const events: ChatEvent[] = [];
    for await (const ev of readYouTubeChat(
      session,
      { signal: new AbortController().signal, mode: 'stream', onStatus: (s) => statuses.push(s), streamId: 's1' },
      {
        quota,
        api: new YouTubeDataApi({ quota }),
        pool,
        tokens: new AccessTokenCache(null),
        apiKey: 'test-key',
        log,
        pollMinMs: 10,
        streamId: 's1',
      },
    )) {
      events.push(ev);
    }
    expect(events.map((e) => e.text)).toEqual(['no way', 'LOL', 'GG']);
    expect(calls).toEqual([
      { pageToken: undefined, apiKey: 'test-key' },
      { pageToken: 'tok1', apiKey: 'test-key' },
    ]);
    expect(await quota.usedToday()).toBe(10); // 2 connections × 5 units
    expect(statuses.at(-1)?.state).toBe('ended');
    pool.close();
    await quota.close();
  });

  it('ends with an error status on PERMISSION_DENIED without OAuth', async () => {
    scenario = 'permission';
    const db = new MemoryDb();
    const quota = new QuotaLedger({ db, dailyLimit: 10_000 });
    const pool = new StreamListPool(`127.0.0.1:${port}`, 1, grpc.credentials.createInsecure());
    const statuses: ChatTransportStatus[] = [];
    const it = readYouTubeChat(
      session,
      { signal: new AbortController().signal, mode: 'stream', onStatus: (s) => statuses.push(s) },
      { quota, api: new YouTubeDataApi({ quota }), pool, tokens: new AccessTokenCache(null), apiKey: 'k', log, pollMinMs: 10 },
    );
    const out: ChatEvent[] = [];
    for await (const ev of it) out.push(ev);
    expect(out).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ state: 'error' });
    pool.close();
    await quota.close();
  });
});

describe('list polling fallback', () => {
  it('honors pollingIntervalMillis floor, follows pageToken and stops on liveChatEnded', async () => {
    const db = new MemoryDb();
    const quota = new QuotaLedger({ db, dailyLimit: 10_000 });
    const seenTokens: Array<string | null> = [];
    let n = 0;
    const fetchImpl = (async (url: string) => {
      const u = new URL(url);
      seenTokens.push(u.searchParams.get('pageToken'));
      n++;
      if (n === 1)
        return new Response(
          JSON.stringify({
            nextPageToken: 'p2',
            pollingIntervalMillis: 5,
            items: [{ id: 'a', snippet: { type: 'textMessageEvent', publishedAt: '2026-11-19T14:00:00Z', textMessageDetails: { messageText: 'hi' } }, authorDetails: { channelId: 'UCa' } }],
          }),
        );
      return new Response(JSON.stringify({ error: { errors: [{ reason: 'liveChatEnded' }], message: 'ended' } }), { status: 403 });
    }) as unknown as typeof fetch;
    const api = new YouTubeDataApi({ quota, apiKey: 'k', fetchImpl });
    const out: ChatEvent[] = [];
    for await (const ev of readYouTubeChat(
      { platform: 'youtube', channelId: 'c', videoId: 'v', liveChatId: 'lc', title: null, startedAt: 0, url: '' },
      { signal: new AbortController().signal, mode: 'poll' },
      { quota, api, pool: null as any, tokens: new AccessTokenCache(null), apiKey: 'k', log, pollMinMs: 20 },
    ))
      out.push(ev);
    expect(out.map((e) => e.text)).toEqual(['hi']);
    expect(seenTokens).toEqual([null, 'p2']);
    expect(await quota.usedToday()).toBe(10);
    await quota.close();
  });
});
