/** Time helpers. All values are epoch milliseconds unless noted. */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/**
 * A clock that runs `speed`× faster than wall time from `startTs`.
 * Replay uses it so a recorded VOD can be fed faster than real time while
 * every component keeps consistent timestamps.
 */
export function scaledClock(startTs: number, speed: number, wall: () => number = Date.now): Clock {
  const wallStart = wall();
  return { now: () => startTs + (wall() - wallStart) * speed };
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Exponential backoff with full jitter. */
export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

const PT = 'America/Los_Angeles';

/** YouTube quota resets at midnight Pacific. Returns e.g. "2026-11-19". */
export function pacificDayKey(ts = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PT, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(ts),
  );
}

/** Offset of a time zone from UTC in minutes at instant `ts` (e.g. -480 for PST). */
export function tzOffsetMinutes(timeZone: string, ts = Date.now()): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return Math.round((asUtc - Math.floor(ts / 1000) * 1000) / 60_000);
}

/** Epoch ms of the most recent midnight Pacific (start of the current quota day). */
export function pacificDayStart(ts = Date.now()): number {
  const key = pacificDayKey(ts);
  const [y, m, d] = key.split('-').map(Number);
  const naiveMidnightUtc = Date.UTC(y, m - 1, d);
  // Offset at (approximately) that midnight; DST switches happen at 2am so this is safe.
  const offset = tzOffsetMinutes(PT, naiveMidnightUtc + 12 * 3600_000);
  return naiveMidnightUtc - offset * 60_000;
}

export const toSec = (ms: number) => Math.floor(ms / 1000);
export const iso = (ms: number) => new Date(ms).toISOString();
export const fromIso = (s: string | null | undefined): number | null => (s ? Date.parse(s) : null);

/** "1:23:45" style offset label. */
export function formatOffset(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
