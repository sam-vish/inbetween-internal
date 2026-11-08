/**
 * Moment scorer (PRD 4.5).
 *
 *   score(t) = Σ w_i · z_i(t)  +  w_vision · vision_conf(t)
 *
 * - z-scores come pre-normalized from the signal workers (EWMA baseline).
 * - Paid-message suppression: audio_loud, voice_hype and chat_rate are
 *   down-weighted for [paid, paid + paid_suppression_s].
 * - Lag alignment: fast signals use their max over the last align_window_s
 *   seconds (see TimingSchema.align_window_s).
 * - Smoothed over smoothing_s seconds; triggers when smoothed ≥ threshold
 *   AND ≥ families_required distinct families are elevated.
 * - The moment stays open while smoothed ≥ extend_ratio × threshold, then
 *   closes; event time = audio peak in the 20s before the chat peak, else
 *   chat peak − chat_lag_s. Window = [event − pre_roll, event + post_roll],
 *   extended to the last above-extend second, capped at max_clip_s.
 * - Cooldown: a new moment inside cooldown_s of the previous one extends it.
 *
 * Seconds are evaluated at `now − scorer_delay_s` so slower signals (ASR)
 * have landed. Every evaluated second produces a SignalSampleRow.
 */
import {
  type ClientConfig,
  SIGNAL_FAMILY,
  type SignalBreakdown,
  type SignalFamily,
  type SignalName,
  type SignalSample,
  type SignalSampleRow,
} from '@inbetween/shared';

export interface MomentCandidate {
  /** Stable key within this scorer, used for extend events. */
  key: string;
  eventTs: number;
  startTs: number;
  endTs: number;
  score: number;
  breakdown: SignalBreakdown;
  paidSuppressed: boolean;
  visionLabel: string | null;
  chatPeakTs: number | null;
  triggerTs: number;
  reason: string;
}

export interface ScorerEvents {
  onMoment(m: MomentCandidate): void;
  onExtend?(m: MomentCandidate): void;
  onSuppressed?(m: MomentCandidate, why: string): void;
  onRow?(row: SignalSampleRow): void;
  onBurst?(untilTs: number): void;
}

type Cell = { raw: number; z: number; label?: string };

const Z_SIGNALS: Exclude<SignalName, 'vision_event'>[] = ['chat_rate', 'chat_reaction', 'chat_caps', 'audio_loud', 'voice_hype'];
const SUPPRESSIBLE = new Set<SignalName>(['audio_loud', 'voice_hype', 'chat_rate']);
const FAST = new Set<SignalName>(['audio_loud', 'voice_hype', 'vision_event']);

interface Evaluated {
  sec: number;
  raw: number;
  smoothed: number;
  breakdown: SignalBreakdown;
  families: Set<SignalFamily>;
  suppressed: boolean;
  visionLabel: string | null;
}

interface OpenMoment {
  startSec: number;
  lastAboveSec: number;
  peak: Evaluated;
  suppressedSeen: boolean;
  visionLabels: Map<string, number>;
}

export class MomentScorer {
  private cells = new Map<number, Partial<Record<SignalName, Cell>>>();
  private paidSecs: number[] = [];
  private evaluated = new Map<number, Evaluated>();
  private evaluatedUpTo: number | null = null;
  private open: OpenMoment | null = null;
  private emitted: MomentCandidate[] = [];
  private seq = 0;
  private burstUntil = 0;
  lateSamples = 0;
  delayS: number;

  constructor(
    readonly streamId: string,
    private cfg: ClientConfig,
    private events: ScorerEvents,
  ) {
    this.delayS = cfg.timing.scorer_delay_s;
  }

  updateConfig(cfg: ClientConfig) {
    this.cfg = cfg;
  }

  ingest(s: SignalSample) {
    if (this.evaluatedUpTo != null && s.sec <= this.evaluatedUpTo) {
      this.lateSamples++;
      return;
    }
    let row = this.cells.get(s.sec);
    if (!row) {
      row = {};
      this.cells.set(s.sec, row);
    }
    row[s.signal] = { raw: s.raw, z: s.z, label: s.label };
  }

  ingestPaid(ts: number) {
    this.paidSecs.push(Math.floor(ts / 1000));
    if (this.paidSecs.length > 500) this.paidSecs.splice(0, this.paidSecs.length - 500);
  }

  private isSuppressed(sec: number) {
    const win = this.cfg.timing.paid_suppression_s;
    for (let i = this.paidSecs.length - 1; i >= 0; i--) {
      const p = this.paidSecs[i];
      if (sec >= p && sec <= p + win) return true;
    }
    return false;
  }

  /** Effective contribution + z for one signal at one second (before alignment). */
  private cellAt(sec: number, name: SignalName) {
    const c = this.cells.get(sec)?.[name];
    if (!c) return null;
    const t = this.cfg.timing;
    if (name === 'vision_event') {
      const conf = Math.max(0, Math.min(1, c.z));
      return { raw: c.raw, z: conf, contribution: this.cfg.weights.vision_event * conf, suppressed: false, label: c.label };
    }
    const suppressed = SUPPRESSIBLE.has(name) && this.isSuppressed(sec);
    const factor = suppressed ? t.paid_suppression_factor : 1;
    const z = Math.max(-1, Math.min(10, c.z));
    return { raw: c.raw, z: z * factor, contribution: this.cfg.weights[name] * z * factor, suppressed, label: c.label };
  }

  private evaluateSecond(sec: number): Evaluated {
    const t = this.cfg.timing;
    const thr = this.cfg.thresholds;
    const breakdown: SignalBreakdown = {};
    const families = new Set<SignalFamily>();
    let raw = 0;
    let suppressedAny = false;
    let visionLabel: string | null = null;

    const names: SignalName[] = [...Z_SIGNALS, 'vision_event'];
    for (const name of names) {
      let best: ReturnType<MomentScorer['cellAt']> = null;
      if (FAST.has(name)) {
        // Lag alignment: max over [sec - window, sec]. Vision also honors hold_s.
        const window = name === 'vision_event' ? Math.max(t.align_window_s, this.cfg.vision.hold_s) : t.align_window_s;
        for (let s = sec - Math.floor(window); s <= sec; s++) {
          const c = this.cellAt(s, name);
          if (c && (!best || c.contribution > best.contribution)) best = c;
        }
      } else {
        best = this.cellAt(sec, name);
      }
      if (!best) continue;
      breakdown[name] = {
        raw: round(best.raw),
        z: round(best.z),
        weight: name === 'vision_event' ? this.cfg.weights.vision_event : this.cfg.weights[name],
        contribution: round(best.contribution),
        suppressed: best.suppressed,
      };
      raw += best.contribution;
      if (best.suppressed) suppressedAny = true;
      // Suppressed signals are presumed explained by the paid event: they never count as an elevated family.
      const elevated = name === 'vision_event' ? best.z >= thr.vision_min_conf : !best.suppressed && best.z >= thr.family_z;
      if (elevated) families.add(SIGNAL_FAMILY[name]);
      if (name === 'vision_event' && best.label && best.label !== 'none' && best.z >= thr.vision_min_conf) visionLabel = best.label;
    }

    let sum = raw;
    let n = 1;
    for (let k = 1; k < t.smoothing_s; k++) {
      const prev = this.evaluated.get(sec - k);
      if (prev) {
        sum += prev.raw;
        n++;
      }
    }
    const ev: Evaluated = { sec, raw, smoothed: sum / n, breakdown, families, suppressed: suppressedAny, visionLabel };
    this.evaluated.set(sec, ev);

    const rawOf = (name: SignalName) => this.cells.get(sec)?.[name]?.raw ?? null;
    const zOut: Partial<Record<SignalName, number>> = {};
    for (const name of names) {
      const c = this.cells.get(sec)?.[name];
      if (c) zOut[name] = round(c.z);
    }
    this.events.onRow?.({
      streamId: this.streamId,
      sec,
      chat_rate: rawOf('chat_rate'),
      chat_reaction: rawOf('chat_reaction'),
      chat_caps: rawOf('chat_caps'),
      audio_loud: rawOf('audio_loud'),
      voice_hype: rawOf('voice_hype'),
      vision_conf: this.cells.get(sec)?.vision_event?.z ?? null,
      vision_label: this.cells.get(sec)?.vision_event?.label ?? null,
      z: zOut,
      score: round(ev.smoothed),
      paidSuppressed: suppressedAny,
    });
    return ev;
  }

  private step(ev: Evaluated) {
    const thr = this.cfg.thresholds;
    const t = this.cfg.timing;
    const extendLevel = t.extend_ratio * thr.score;
    if (!this.open) {
      if (ev.smoothed >= thr.score && ev.families.size >= thr.families_required) {
        this.open = { startSec: ev.sec, lastAboveSec: ev.sec, peak: ev, suppressedSeen: ev.suppressed, visionLabels: new Map() };
        if (ev.visionLabel) this.open.visionLabels.set(ev.visionLabel, 1);
      }
      return;
    }
    const o = this.open;
    if (ev.suppressed) o.suppressedSeen = true;
    if (ev.visionLabel) o.visionLabels.set(ev.visionLabel, (o.visionLabels.get(ev.visionLabel) ?? 0) + 1);
    if (ev.smoothed >= extendLevel) {
      o.lastAboveSec = ev.sec;
      if (ev.smoothed > o.peak.smoothed) o.peak = ev;
    }
    const tooLong = ev.sec - o.startSec >= t.max_open_s;
    if (tooLong || ev.sec - o.lastAboveSec >= t.close_after_s) this.close();
  }

  private argmax(from: number, to: number, f: (sec: number) => number | null): { sec: number; v: number } | null {
    let best: { sec: number; v: number } | null = null;
    for (let s = from; s <= to; s++) {
      const v = f(s);
      if (v != null && (!best || v > best.v)) best = { sec: s, v };
    }
    return best;
  }

  private close() {
    const o = this.open!;
    this.open = null;
    const t = this.cfg.timing;
    const thr = this.cfg.thresholds;

    // ---- chat-lag correction: event time ----
    const chatZ = (s: number) => this.cells.get(s)?.chat_rate?.z ?? null;
    const chatPeak = this.argmax(o.startSec - 2, o.lastAboveSec, chatZ);
    const audioRaw = (s: number) => (this.isSuppressed(s) ? null : this.cells.get(s)?.audio_loud?.raw ?? null);
    let eventSec: number;
    let chatPeakTs: number | null = null;
    let how: string;
    if (chatPeak && chatPeak.v >= thr.family_z) {
      chatPeakTs = chatPeak.sec * 1000;
      const ap = this.argmax(chatPeak.sec - t.audio_peak_lookback_s, chatPeak.sec, audioRaw);
      const apZ = ap ? (this.cells.get(ap.sec)?.audio_loud?.z ?? 0) : 0;
      if (ap && apZ >= t.audio_peak_min_z) {
        eventSec = ap.sec;
        how = `audio peak ${chatPeak.sec - ap.sec}s before chat peak`;
      } else {
        eventSec = chatPeak.sec - t.chat_lag_s;
        how = `chat peak − ${t.chat_lag_s}s`;
      }
    } else {
      // Triggered without chat (audio/voice/vision): use the loudest second near the trigger.
      const ap = this.argmax(o.startSec - t.align_window_s, o.lastAboveSec, audioRaw);
      eventSec = ap?.sec ?? o.startSec;
      how = ap ? 'audio peak (no chat peak)' : 'trigger time';
    }

    const startSec = eventSec - t.pre_roll_s;
    let endSec = Math.max(eventSec + t.post_roll_s, o.lastAboveSec);
    endSec = Math.min(endSec, startSec + t.max_clip_s);

    const visionLabel = [...o.visionLabels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const top = Object.entries(o.peak.breakdown)
      .filter(([, b]) => b && b.contribution > 0)
      .sort((a, b) => b[1]!.contribution - a[1]!.contribution)
      .slice(0, 3)
      .map(([k, b]) => `${k} z=${b!.z.toFixed(1)}`)
      .join(', ');

    const cand: MomentCandidate = {
      key: `${this.streamId}:${++this.seq}`,
      eventTs: eventSec * 1000,
      startTs: startSec * 1000,
      endTs: endSec * 1000,
      score: round(o.peak.smoothed),
      breakdown: o.peak.breakdown,
      paidSuppressed: o.suppressedSeen,
      visionLabel,
      chatPeakTs,
      triggerTs: o.startSec * 1000,
      reason: `${top}${visionLabel ? `, vision: ${visionLabel}` : ''}; event = ${how}`,
    };

    // ---- cooldown: extend the previous moment instead of creating a new one ----
    const last = this.emitted.at(-1);
    if (last && (cand.eventTs - last.eventTs < thr.cooldown_s * 1000 || cand.startTs < last.endTs)) {
      const newEnd = Math.min(Math.max(last.endTs, cand.endTs), last.startTs + t.max_clip_s * 1000);
      if (newEnd > last.endTs + 999) {
        last.endTs = newEnd;
        last.score = Math.max(last.score, cand.score);
        last.paidSuppressed ||= cand.paidSuppressed;
        last.visionLabel ??= cand.visionLabel;
        this.events.onExtend?.({ ...last });
      } else {
        this.events.onSuppressed?.(cand, 'inside cooldown, already at max length');
      }
      return;
    }

    // ---- max clips/hour (strong moments still pass) ----
    const hourAgo = cand.eventTs - 3600_000;
    const recent = this.emitted.filter((m) => m.eventTs >= hourAgo).length;
    if (recent >= thr.max_clips_per_hour && cand.score < 1.5 * thr.score) {
      this.events.onSuppressed?.(cand, `max_clips_per_hour (${thr.max_clips_per_hour}) reached`);
      return;
    }
    this.emitted.push(cand);
    if (this.emitted.length > 200) this.emitted.shift();
    this.events.onMoment({ ...cand });
  }

  /** Cheap (chat + audio) score at the newest second with chat data, for vision bursts. */
  private checkBurst(nowMs: number) {
    if (!this.events.onBurst) return;
    const nowSec = Math.floor(nowMs / 1000);
    let latest: number | null = null;
    for (let s = nowSec; s > nowSec - 6; s--) {
      if (this.cells.get(s)?.chat_rate) {
        latest = s;
        break;
      }
    }
    if (latest == null) return;
    let cheap = 0;
    for (const name of ['chat_rate', 'chat_reaction', 'chat_caps'] as const) cheap += this.cellAt(latest, name)?.contribution ?? 0;
    let audio = 0;
    for (let s = latest - Math.floor(this.cfg.timing.align_window_s); s <= nowSec; s++) {
      audio = Math.max(audio, this.cellAt(s, 'audio_loud')?.contribution ?? 0);
    }
    cheap += audio;
    if (cheap >= this.cfg.vision.burst_ratio * this.cfg.thresholds.score && nowMs >= this.burstUntil - 5000) {
      this.burstUntil = nowMs + this.cfg.vision.burst_duration_s * 1000;
      this.events.onBurst(this.burstUntil);
    }
  }

  /** Evaluates all seconds up to now − delay. Call ~1×/s. */
  tick(nowMs: number) {
    this.checkBurst(nowMs);
    const target = Math.floor(nowMs / 1000) - Math.ceil(this.delayS);
    this.evaluateThrough(target);
  }

  private evaluateThrough(target: number) {
    if (this.evaluatedUpTo == null) {
      const first = Math.min(...this.cells.keys());
      if (!Number.isFinite(first) || first > target) return;
      this.evaluatedUpTo = first - 1;
    }
    // Bound catch-up work after a stall.
    if (target - this.evaluatedUpTo > 900) this.evaluatedUpTo = target - 900;
    for (let s = this.evaluatedUpTo + 1; s <= target; s++) {
      this.step(this.evaluateSecond(s));
      this.evaluatedUpTo = s;
    }
    this.gc(target);
  }

  /** End of stream: evaluate what's left and close any open moment. */
  flush() {
    const last = Math.max(...this.cells.keys());
    if (Number.isFinite(last)) this.evaluateThrough(last);
    if (this.open) this.close();
  }

  private gc(upTo: number) {
    const keep = upTo - 180;
    for (const k of this.cells.keys()) if (k < keep) this.cells.delete(k);
    for (const k of this.evaluated.keys()) if (k < keep) this.evaluated.delete(k);
  }

  get emittedMoments(): readonly MomentCandidate[] {
    return this.emitted;
  }
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
