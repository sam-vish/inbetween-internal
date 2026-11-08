/**
 * Replay adapter: feeds a recorded VOD + saved chat log through the real
 * pipeline as if it were live (PRD 11: scripts/replay.ts). Chat events are
 * released on the (optionally sped-up) stream clock.
 */
import path from 'node:path';
import type { ChannelRef, ChatEvent, ChatOpenOptions, Clock, HlsSource, LiveSession, PlatformAdapter } from '@inbetween/shared';
import { sleep } from '@inbetween/shared';

export interface ReplayOptions {
  videoPath: string;
  /** Events with `ts` = ms offset from the start of the VOD. */
  chat: ChatEvent[];
  speed: number;
  clock: Clock;
  startTs: number;
  title?: string;
}

/** Simple JSONL chat format: {"t": seconds, "author": "...", "text": "...", "paid": false, "amount": 0, "currency": "INR"} */
export function parseSimpleChatJsonl(content: string): ChatEvent[] {
  const out: ChatEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    const j = JSON.parse(line);
    const ts = Math.round(Number(j.t ?? j.offset_s ?? 0) * 1000);
    out.push({
      id: String(j.id ?? `${ts}-${out.length}`),
      platform: 'replay',
      ts,
      authorId: String(j.author ?? `anon${out.length}`),
      authorName: String(j.author ?? 'anon'),
      text: String(j.text ?? ''),
      kind: j.paid ? 'paid_message' : 'text',
      isPaid: !!j.paid,
      amount: Number(j.amount ?? 0),
      currency: j.currency ?? null,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export class ReplayAdapter implements PlatformAdapter {
  readonly platform = 'replay' as const;
  constructor(private o: ReplayOptions) {}

  session(): LiveSession {
    return {
      platform: 'replay',
      channelId: 'replay',
      videoId: path.basename(this.o.videoPath).replace(/\.[^.]+$/, '').slice(0, 40),
      liveChatId: 'replay',
      title: this.o.title ?? path.basename(this.o.videoPath),
      startedAt: this.o.startTs,
      url: `file://${path.resolve(this.o.videoPath)}`,
    };
  }

  async detectLive(_c: ChannelRef) {
    return this.session();
  }

  openVideo(): HlsSource {
    return { kind: 'file', path: path.resolve(this.o.videoPath), speed: this.o.speed };
  }

  async *openChat(_s: LiveSession, opts: ChatOpenOptions): AsyncIterable<ChatEvent> {
    opts.onStatus?.({ transport: 'stream', state: 'connected', expectedDelayMs: 500 });
    for (const ev of this.o.chat) {
      const ts = this.o.startTs + ev.ts;
      const waitMs = (ts - this.o.clock.now()) / this.o.speed;
      if (waitMs > 0) await sleep(waitMs, opts.signal);
      if (opts.signal.aborted) return;
      yield { ...ev, ts };
    }
    // Keep the transport "open" until the video ends, like a real chat.
    while (!opts.signal.aborted) await sleep(1000, opts.signal);
  }

  async isStillLive() {
    return true;
  }

  timestampUrl(_s: LiveSession, offsetS: number) {
    return `${path.basename(this.o.videoPath)}#t=${Math.floor(offsetS)}`;
  }
}
