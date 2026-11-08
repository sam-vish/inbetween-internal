/**
 * voice_hype producer: keeps the last minute of PCM in memory, sends one
 * window (voice.window_s, default 6s) at a time to the live ASR provider and
 * publishes hype-phrase hits per second. Near-silent windows skip ASR.
 */
import type { AsrProvider } from '@inbetween/providers';
import type { ClientConfig, CostReporter, Logger } from '@inbetween/shared';
import { HypePhraseMatcher, rmsDbfs, SAMPLE_RATE, wavFromPcm } from '@inbetween/signals';

const BYTES_PER_SEC = SAMPLE_RATE * 2;

export interface VoiceWindowResult {
  startTs: number;
  perSecond: Array<{ sec: number; hits: number }>;
  text: string;
}

export class VoiceProducer {
  private chunks: Array<{ ts: number; buf: Buffer }> = [];
  private windowStartTs: number | null = null;
  private windowBytes: Buffer[] = [];
  private windowLen = 0;
  private busy = false;
  private matcher: HypePhraseMatcher;
  private transcripts: Array<{ ts: number; text: string }> = [];
  stats = { windows: 0, skippedSilent: 0, skippedBusy: 0, errors: 0 };

  constructor(
    private cfg: ClientConfig,
    private asr: AsrProvider | null,
    private onWindow: (r: VoiceWindowResult) => void,
    private log: Logger,
    private cost?: CostReporter,
  ) {
    this.matcher = HypePhraseMatcher.forConfig(cfg);
  }

  /** PCM chunk whose first sample is at `ts` (stream clock, ms). */
  push(buf: Buffer, ts: number) {
    if (!this.cfg.voice.enabled) return;
    if (this.windowStartTs == null) this.windowStartTs = ts;
    this.windowBytes.push(buf);
    this.windowLen += buf.length;
    const need = Math.round(this.cfg.voice.window_s * BYTES_PER_SEC);
    if (this.windowLen >= need) {
      const all = Buffer.concat(this.windowBytes);
      const pcm = all.subarray(0, need);
      const rest = all.subarray(need);
      const startTs = this.windowStartTs;
      this.windowStartTs = startTs + (need / BYTES_PER_SEC) * 1000;
      this.windowBytes = rest.length ? [rest] : [];
      this.windowLen = rest.length;
      void this.process(pcm, startTs);
    }
  }

  private async process(pcm: Buffer, startTs: number) {
    const fromSec = Math.floor(startTs / 1000);
    const toSec = Math.floor((startTs + (pcm.length / BYTES_PER_SEC) * 1000) / 1000);
    const zeros = () => {
      const out: Array<{ sec: number; hits: number }> = [];
      for (let s = fromSec; s < toSec; s++) out.push({ sec: s, hits: 0 });
      return out;
    };
    const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length));
    if (!this.asr || rmsDbfs(samples) < -55) {
      this.stats.skippedSilent++;
      this.onWindow({ startTs, perSecond: zeros(), text: '' });
      return;
    }
    if (this.busy) {
      // Never queue ASR behind itself: a late voice signal is useless to the scorer.
      this.stats.skippedBusy++;
      this.onWindow({ startTs, perSecond: zeros(), text: '' });
      return;
    }
    this.busy = true;
    try {
      const r = await this.asr.transcribe(wavFromPcm(pcm), {
        language: this.cfg.caption_language,
        purpose: 'live',
        cost: this.cost,
        signal: AbortSignal.timeout(8000),
      });
      this.stats.windows++;
      const words = r.words.map((w) => ({ w: w.w, start: startTs + w.start * 1000, end: startTs + w.end * 1000 }));
      this.transcripts.push({ ts: startTs, text: r.text });
      if (this.transcripts.length > 30) this.transcripts.shift();
      this.onWindow({ startTs, perSecond: this.matcher.perSecond(words, fromSec, toSec), text: r.text });
    } catch (err) {
      this.stats.errors++;
      this.log.warn({ err: (err as Error).message }, 'live ASR failed');
      this.onWindow({ startTs, perSecond: zeros(), text: '' });
    } finally {
      this.busy = false;
    }
  }

  /** Rough live transcript around a time (the clip gets a proper ASR pass later). */
  transcriptAround(fromTs: number, toTs: number): string {
    return this.transcripts
      .filter((t) => t.ts >= fromTs - 6000 && t.ts <= toTs)
      .map((t) => t.text)
      .join(' ')
      .trim();
  }

  reset() {
    this.windowStartTs = null;
    this.windowBytes = [];
    this.windowLen = 0;
    void this.chunks;
  }
}
