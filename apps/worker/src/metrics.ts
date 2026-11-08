/** In-process counters + latency percentiles exposed at /metrics. */

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export class Metrics {
  readonly startedAt = Date.now();
  private counters = new Map<string, number>();
  /** moment (event time) → fast clip ready, ms. */
  private latencies: number[] = [];
  private renderMs: number[] = [];
  private streamProbes = new Map<string, () => Record<string, unknown>>();

  inc(name: string, n = 1) {
    this.counters.set(name, (this.counters.get(name) ?? 0) + n);
  }

  recordClipLatency(ms: number) {
    this.latencies.push(ms);
    if (this.latencies.length > 500) this.latencies.shift();
  }

  recordRender(ms: number) {
    this.renderMs.push(ms);
    if (this.renderMs.length > 500) this.renderMs.shift();
  }

  registerStream(streamId: string, probe: () => Record<string, unknown>) {
    this.streamProbes.set(streamId, probe);
    return () => this.streamProbes.delete(streamId);
  }

  latencySummary() {
    return {
      n: this.latencies.length,
      p50_ms: percentile(this.latencies, 50),
      p95_ms: percentile(this.latencies, 95),
      render_p50_ms: percentile(this.renderMs, 50),
    };
  }

  snapshot(extra: Record<string, unknown> = {}) {
    const mem = process.memoryUsage();
    return {
      uptime_s: Math.round((Date.now() - this.startedAt) / 1000),
      memory_mb: { rss: Math.round(mem.rss / 1e6), heap: Math.round(mem.heapUsed / 1e6) },
      counters: Object.fromEntries(this.counters),
      clip_latency: this.latencySummary(),
      streams: Object.fromEntries([...this.streamProbes].map(([id, f]) => [id, f()])),
      ...extra,
    };
  }
}
