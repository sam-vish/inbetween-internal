/**
 * Video source for the ingest worker: a process that writes the live HLS
 * as MPEG-TS to stdout. streamlink by default ("720p60 or best available"),
 * yt-dlp as an alternative resolver.
 */
import type { HlsSource, LiveSession } from '@inbetween/shared';
import { type Cookie, streamlinkCookieArgs } from './cookies';

export interface VideoSourceOptions {
  resolver: 'streamlink' | 'ytdlp';
  quality: string;
  streamlinkBin: string;
  ytdlpBin: string;
  cookiesFile?: string;
  cookies?: Cookie[];
}

export function buildVideoSource(session: LiveSession, o: VideoSourceOptions): HlsSource {
  if (o.resolver === 'ytdlp') {
    const fmt = o.quality
      .split(',')
      .map((q) => {
        const m = q.trim().match(/^(\d+)p(\d+)?$/);
        if (!m) return 'best';
        return m[2] ? `best[height<=${m[1]}][fps>=${m[2]}]` : `best[height<=${m[1]}]`;
      })
      .join('/');
    const args = ['--no-warnings', '--quiet', '-f', fmt, '--hls-use-mpegts', '--no-part', '-o', '-'];
    if (o.cookiesFile) args.push('--cookies', o.cookiesFile);
    args.push(session.url);
    return { kind: 'command', cmd: o.ytdlpBin, args };
  }
  const args = [
    '--stdout',
    '--loglevel',
    'warning',
    '--hls-live-edge',
    '2',
    '--stream-segment-threads',
    '2',
    '--stream-timeout',
    '30',
    '--retry-open',
    '3',
    '--retry-streams',
    '5',
    ...streamlinkCookieArgs(o.cookies ?? []),
    session.url,
    o.quality,
  ];
  return { kind: 'command', cmd: o.streamlinkBin, args };
}
