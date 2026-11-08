/**
 * Cost logging (PRD 4.10). Every external API call (ASR, vision, Claude)
 * reports usage here; rows go to `cost_events` in batches and per-stream
 * totals are kept in memory to enforce the hard cost cap.
 */
import type { Db } from './db/types';
import type { Logger } from './log';
import type { CostEventRow } from './types';

export interface PriceEntry {
  /** USD per hour of audio. */
  perAudioHour?: number;
  /** Minimum billed seconds per request (Groq bills ≥10s). */
  minBilledS?: number;
  /** USD per 1M input / output tokens. */
  inPerM?: number;
  outPerM?: number;
}

/**
 * Estimates only. Verified against provider pricing pages on 2026-11-08 where
 * noted; override at runtime with PRICING_OVERRIDES_JSON='{"groq:whisper-large-v3":{"perAudioHour":0.111}}'.
 */
export const DEFAULT_PRICING: Record<string, PriceEntry> = {
  'groq:whisper-large-v3-turbo': { perAudioHour: 0.04, minBilledS: 10 },
  'groq:whisper-large-v3': { perAudioHour: 0.111, minBilledS: 10 },
  'deepgram:nova-3': { perAudioHour: 0.0043 * 60 },
  'deepgram:nova-2': { perAudioHour: 0.0043 * 60 },
  'sarvam:saaras:v4': { perAudioHour: 0.36 },
  'sarvam:saaras:v3': { perAudioHour: 0.36 },
  // ai.google.dev/gemini-api/docs/pricing (checked 2026-11-08)
  'gemini:gemini-3.5-flash-lite': { inPerM: 0.3, outPerM: 2.5 },
  'gemini:gemini-3.6-flash': { inPerM: 0.75, outPerM: 3.75 },
  // Claude API pricing (claude-api skill, cached 2026-10-06)
  'anthropic:claude-opus-5-5': { inPerM: 4, outPerM: 20 },
  'anthropic:claude-sonnet-5-5': { inPerM: 2, outPerM: 10 },
  'anthropic:claude-haiku-5-5': { inPerM: 0.1, outPerM: 0.5 },
};

export class Pricing {
  private table: Record<string, PriceEntry>;
  constructor(overridesJson?: string) {
    this.table = { ...DEFAULT_PRICING };
    if (overridesJson) {
      try {
        Object.assign(this.table, JSON.parse(overridesJson));
      } catch {
        /* ignore malformed overrides */
      }
    }
  }
  audioCost(key: string, seconds: number): number {
    const p = this.table[key];
    if (!p?.perAudioHour) return 0;
    const billed = Math.max(seconds, p.minBilledS ?? 0);
    return (billed / 3600) * p.perAudioHour;
  }
  tokenCost(key: string, inputTokens: number, outputTokens: number): number {
    const p = this.table[key];
    if (!p) return 0;
    return (inputTokens / 1e6) * (p.inPerM ?? 0) + (outputTokens / 1e6) * (p.outPerM ?? 0);
  }
}

export interface CostContext {
  clientId: string | null;
  streamId: string | null;
}

export interface UsageReport {
  provider: string;
  units: number;
  unitType: 'audio_s' | 'tokens' | 'images' | 'requests';
  estCostUsd: number;
}

export type CostReporter = (u: UsageReport) => void;

export class CostTracker {
  private buffer: CostEventRow[] = [];
  private perStream = new Map<string, number>();
  private capListeners: Array<(streamId: string, total: number) => void> = [];
  private caps = new Map<string, number>();
  private capped = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    readonly pricing: Pricing,
    private log?: Logger,
    flushEveryMs = 5000,
  ) {
    if (flushEveryMs > 0) {
      this.timer = setInterval(() => void this.flush(), flushEveryMs);
      this.timer.unref();
    }
  }

  setCap(streamId: string, capUsd: number, alreadySpent = 0) {
    this.caps.set(streamId, capUsd);
    if (alreadySpent) this.perStream.set(streamId, alreadySpent);
  }

  onCapExceeded(cb: (streamId: string, total: number) => void) {
    this.capListeners.push(cb);
  }

  isCapped(streamId: string | null): boolean {
    return !!streamId && this.capped.has(streamId);
  }

  streamTotal(streamId: string): number {
    return this.perStream.get(streamId) ?? 0;
  }

  /** Binds a context so providers only need to report usage. */
  reporter(ctx: CostContext): CostReporter {
    return (u) => this.record(ctx, u);
  }

  record(ctx: CostContext, u: UsageReport) {
    const row: CostEventRow = {
      clientId: ctx.clientId,
      streamId: ctx.streamId,
      provider: u.provider,
      units: u.units,
      unitType: u.unitType,
      estCostUsd: u.estCostUsd,
      ts: Date.now(),
    };
    this.buffer.push(row);
    if (ctx.streamId) {
      const total = (this.perStream.get(ctx.streamId) ?? 0) + u.estCostUsd;
      this.perStream.set(ctx.streamId, total);
      const cap = this.caps.get(ctx.streamId);
      if (cap != null && total > cap && !this.capped.has(ctx.streamId)) {
        this.capped.add(ctx.streamId);
        this.log?.warn({ streamId: ctx.streamId, total, cap }, 'stream cost cap exceeded');
        for (const l of this.capListeners) l(ctx.streamId, total);
      }
    }
  }

  async flush() {
    if (!this.buffer.length) return;
    const rows = this.buffer.splice(0);
    try {
      await this.db.insertCostEvents(rows);
    } catch (err) {
      this.log?.error({ err }, 'cost flush failed; re-queueing');
      this.buffer.unshift(...rows);
    }
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.flush();
  }
}
