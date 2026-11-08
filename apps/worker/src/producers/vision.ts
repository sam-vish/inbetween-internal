/**
 * vision_event producer (PRD 4.4): 1 frame / 10s normally, 1 frame / 2s for
 * 30s after a burst trigger (cheap score ≥ 0.6 × threshold). Above the
 * stream's cost cap it degrades to sparse-only.
 */
import fs from 'node:fs/promises';
import { type GameProfile, loadGameProfile, type VisionProvider, type VisionResult } from '@inbetween/providers';
import type { ClientConfig, Clock, CostReporter, Logger } from '@inbetween/shared';
import type { FrameRef } from '../ingest/ingest';

export class VisionProducer {
  private lastSampleTs = 0;
  private burstUntil = 0;
  private busy = false;
  private profile: GameProfile;
  stats = { frames: 0, events: 0, errors: 0, bursts: 0 };

  constructor(
    private cfg: ClientConfig,
    private provider: VisionProvider | null,
    private clock: Clock,
    private latestFrame: () => FrameRef | null,
    private onResult: (frame: FrameRef, r: VisionResult) => void,
    private isCapped: () => boolean,
    private log: Logger,
    private cost?: CostReporter,
  ) {
    this.profile = loadGameProfile(cfg.vision.game_profile);
  }

  burst(untilTs: number) {
    if (this.isCapped()) return;
    if (untilTs > this.burstUntil) {
      this.burstUntil = untilTs;
      this.stats.bursts++;
    }
  }

  get inBurst() {
    return this.clock.now() < this.burstUntil && !this.isCapped();
  }

  tick() {
    if (!this.cfg.vision.enabled || !this.provider || this.busy) return;
    const now = this.clock.now();
    const interval = (this.inBurst ? this.cfg.vision.burst_interval_s : this.cfg.vision.sparse_interval_s) * 1000;
    if (now - this.lastSampleTs < interval) return;
    const frame = this.latestFrame();
    if (!frame || frame.ts <= this.lastSampleTs) return;
    this.lastSampleTs = frame.ts;
    this.busy = true;
    void (async () => {
      try {
        const jpeg = await fs.readFile(frame.path);
        const r = await this.provider!.classify(jpeg, { profile: this.profile, cost: this.cost, signal: AbortSignal.timeout(15_000) });
        this.stats.frames++;
        if (r.event !== 'none') this.stats.events++;
        this.onResult(frame, r);
      } catch (err) {
        this.stats.errors++;
        this.log.warn({ err: (err as Error).message }, 'vision classify failed');
      } finally {
        this.busy = false;
      }
    })();
  }
}
