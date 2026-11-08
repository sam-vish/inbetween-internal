/**
 * Channel-relative normalization (PRD 4.3): each signal is turned into a
 * z-score against an exponentially weighted mean and variance (~10 min
 * window), so a 300-viewer stream and a 30k-viewer stream are each judged
 * on their own normal.
 */
import type { BaselineSnapshot, EwmaState, SignalName } from '@inbetween/shared';

export interface EwmaOptions {
  /** Effective window in samples (seconds). alpha = 2 / (window + 1). */
  windowS: number;
  /** z is 0 until this many samples have been seen (warm-up). */
  minSamples: number;
  /** Absolute floor for the standard deviation (avoids huge z on dead-quiet chats). */
  stdFloor: number;
  /** Relative floor: std ≥ relStdFloor × |mean|. */
  relStdFloor: number;
  /** Updates are winsorized at mean ± clampSigma × std so one spike can't blow up the variance. */
  clampSigma: number;
}

export class EwmaBaseline {
  mean = 0;
  variance = 0;
  n = 0;
  private alpha: number;

  constructor(readonly opts: EwmaOptions) {
    this.alpha = 2 / (opts.windowS + 1);
  }

  std(): number {
    return Math.max(Math.sqrt(this.variance), this.opts.stdFloor, this.opts.relStdFloor * Math.abs(this.mean));
  }

  /** z-score of x against the baseline BEFORE x is folded in. */
  z(x: number): number {
    if (this.n < this.opts.minSamples) return 0;
    return (x - this.mean) / this.std();
  }

  update(x: number): void {
    if (!Number.isFinite(x)) return;
    if (this.n === 0) {
      this.mean = x;
      this.variance = 0;
      this.n = 1;
      return;
    }
    let v = x;
    if (this.n >= this.opts.minSamples) {
      const lim = this.opts.clampSigma * this.std();
      v = Math.min(this.mean + lim, Math.max(this.mean - lim, x));
    }
    const d = v - this.mean;
    // During warm-up use a faster cumulative average so the baseline settles quickly.
    const a = this.n < this.opts.minSamples ? Math.max(this.alpha, 1 / (this.n + 1)) : this.alpha;
    this.mean += a * d;
    this.variance = (1 - a) * (this.variance + a * d * d);
    this.n++;
  }

  /** Returns z for x, then updates. */
  observe(x: number): number {
    const z = this.z(x);
    this.update(x);
    return z;
  }

  snapshot(): EwmaState {
    return { mean: this.mean, variance: this.variance, n: this.n };
  }

  restore(s: EwmaState | undefined) {
    if (!s || !Number.isFinite(s.mean) || !Number.isFinite(s.variance)) return;
    this.mean = s.mean;
    this.variance = s.variance;
    // A restored baseline from the channel's previous stream is trusted immediately.
    this.n = Math.max(s.n, this.opts.minSamples);
  }
}

/** Per-signal defaults: floors are in the signal's raw units. */
export const SIGNAL_EWMA_DEFAULTS: Record<Exclude<SignalName, 'vision_event'>, Pick<EwmaOptions, 'stdFloor' | 'relStdFloor'>> = {
  chat_rate: { stdFloor: 0.5, relStdFloor: 0.25 }, // msgs/sec
  chat_reaction: { stdFloor: 0.5, relStdFloor: 0.25 }, // weighted tokens/sec
  chat_caps: { stdFloor: 0.05, relStdFloor: 0 }, // share 0..1
  audio_loud: { stdFloor: 2.0, relStdFloor: 0 }, // dB
  // A single stray 'bro' should not count as elevated; 2+ hits in a second should.
  voice_hype: { stdFloor: 0.75, relStdFloor: 0.25 }, // hits/sec
};

export class SignalNormalizer {
  private baselines = new Map<SignalName, EwmaBaseline>();

  constructor(
    private windowS: number,
    private minSamples: number,
    initial?: BaselineSnapshot | null,
  ) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.get(k as SignalName).restore(v);
  }

  get(signal: SignalName): EwmaBaseline {
    let b = this.baselines.get(signal);
    if (!b) {
      const d = SIGNAL_EWMA_DEFAULTS[signal as Exclude<SignalName, 'vision_event'>] ?? { stdFloor: 1, relStdFloor: 0 };
      b = new EwmaBaseline({ windowS: this.windowS, minSamples: this.minSamples, clampSigma: 6, ...d });
      this.baselines.set(signal, b);
    }
    return b;
  }

  observe(signal: SignalName, raw: number): number {
    return this.get(signal).observe(raw);
  }

  snapshot(): BaselineSnapshot {
    const out: BaselineSnapshot = {};
    for (const [k, b] of this.baselines) if (b.n > 0) out[k] = b.snapshot();
    return out;
  }
}
