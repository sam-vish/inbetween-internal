/**
 * No-quota go-live detection (PRD 4.2). Fetches the channel's public
 * `/live` page (and occasionally the `/streams` tab) and extracts the live
 * video ID. A positive result is then confirmed with one `videos.list` call.
 *
 * Markers verified against live YouTube HTML on 2026-11-08:
 *  - live:      `"isLive":true` inside videoPrimaryInfoRenderer and
 *               `"currentVideoEndpoint":{...,"watchEndpoint":{"videoId":"…"`
 *  - not live:  canonical link points at the channel, no isLive marker
 *  - streams tab: `"badgeStyle":"THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE","animationActivationTargetId":"<id>"`
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cookieHeaderFromFile } from './cookies';

const execFileP = promisify(execFile);

export interface ProbeResult {
  live: boolean;
  videoId: string | null;
  upcoming: boolean;
  /** Where the answer came from, for logs. */
  via: 'page' | 'ytdlp' | 'none';
  error?: string;
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  cookiesFile?: string;
  timeoutMs?: number;
}

async function fetchPage(url: string, opts: ProbeOptions): Promise<string> {
  const f = opts.fetchImpl ?? fetch;
  const cookie = ['CONSENT=YES+1', 'SOCS=CAI', opts.cookiesFile ? await cookieHeaderFromFile(opts.cookiesFile) : '']
    .filter(Boolean)
    .join('; ');
  const res = await f(url, {
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

/** Pure parser for the `/channel/<id>/live` page. Exported for tests. */
export function parseLivePage(html: string): Omit<ProbeResult, 'via'> {
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? null;
  const canonicalVideo = canonical?.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ?? null;
  const currentVideo =
    html.match(/"currentVideoEndpoint":\{.{0,600}?"watchEndpoint":\{"videoId":"([A-Za-z0-9_-]{11})"/s)?.[1] ?? null;
  const detailsVideo = html.match(/"videoDetails":\{"videoId":"([A-Za-z0-9_-]{11})"/)?.[1] ?? null;
  const videoId = currentVideo ?? canonicalVideo ?? detailsVideo;

  const isLive = /"isLive":true/.test(html) || /"isLiveNow":true/.test(html);
  const upcoming = /"isUpcoming":true/.test(html) || /"upcomingEventData":/.test(html);

  if (videoId && isLive && !upcoming) return { live: true, videoId, upcoming: false };
  if (videoId && upcoming) return { live: false, videoId, upcoming: true };
  return { live: false, videoId: null, upcoming: false };
}

/** Pure parser for the `/channel/<id>/streams` tab: every video currently badged LIVE. */
export function parseStreamsTab(html: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE","animationActivationTargetId":"([A-Za-z0-9_-]{11})"/g)) {
    ids.add(m[1]);
  }
  // Older renderer layout: videoRenderer … thumbnailOverlayTimeStatusRenderer.style = "LIVE"
  for (const m of html.matchAll(/"videoId":"([A-Za-z0-9_-]{11})"(?:(?!"videoId").){0,4000}?"style":"LIVE"/gs)) {
    ids.add(m[1]);
  }
  return [...ids];
}

export async function probeLivePage(channelId: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  try {
    const html = await fetchPage(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`, opts);
    return { ...parseLivePage(html), via: 'page' };
  } catch (err) {
    return { live: false, videoId: null, upcoming: false, via: 'none', error: (err as Error).message };
  }
}

export async function probeStreamsTab(channelId: string, opts: ProbeOptions = {}): Promise<string[]> {
  const html = await fetchPage(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/streams`, opts);
  return parseStreamsTab(html);
}

/** Fallback probe through yt-dlp (also no API quota). Slower: spawns a process. */
export async function probeWithYtDlp(
  channelId: string,
  opts: { bin?: string; cookiesFile?: string; timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const args = ['--no-warnings', '--skip-download', '--print', '%(id)s|%(live_status)s'];
  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile);
  args.push(`https://www.youtube.com/channel/${channelId}/live`);
  try {
    const { stdout } = await execFileP(opts.bin ?? 'yt-dlp', args, { timeout: opts.timeoutMs ?? 45_000 });
    const [id, status] = stdout.trim().split('\n').pop()!.split('|');
    if (VIDEO_ID.test(id) && status === 'is_live') return { live: true, videoId: id, upcoming: false, via: 'ytdlp' };
    return { live: false, videoId: null, upcoming: status === 'is_upcoming', via: 'ytdlp' };
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? (err as Error).message;
    // "This channel is not currently live" / "The channel is not currently live" is a normal offline answer.
    if (/not currently live/i.test(msg)) return { live: false, videoId: null, upcoming: false, via: 'ytdlp' };
    return { live: false, videoId: null, upcoming: false, via: 'none', error: msg.slice(0, 300) };
  }
}
