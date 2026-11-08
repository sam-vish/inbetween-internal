/**
 * Operator actions. The dashboard inserts rows into `operator_actions`
 * (it never talks to the worker directly, so it can run on Vercel); workers
 * claim them atomically (FOR UPDATE SKIP LOCKED) and act:
 *   approve  → deliver (re-render first if the chosen title differs from the burned one)
 *   reject   → status rejected
 *   trim     → shift start/end (±10s, within the source clip) and re-render
 *   title    → set the chosen title
 *   premium  → status premium + queue the premium lane
 *   rerender → render again
 *   deliver  → (re)send a clip, e.g. an approved premium edit
 */
import { type OperatorAction } from '@inbetween/shared';
import { renderJobId } from '../clipper/clipper';
import type { WorkerDeps } from '../deps';
import type { RenderJob } from '../queue/index';

const MAX_TRIM_S = 10;

export async function handleAction(deps: WorkerDeps, a: OperatorAction): Promise<void> {
  const db = deps.db;
  const moment = a.momentId ? await db.getMoment(a.momentId) : null;
  const clip = a.clipId ? await db.getClip(a.clipId) : moment ? await db.getLatestClip(moment.id, 'fast') : null;
  const p = a.payload ?? {};

  switch (a.action) {
    case 'approve': {
      if (!clip) throw new Error('approve: no clip to deliver');
      if (clip.kind !== 'fast') {
        // Premium/compilation clips: human review happened, deliver as-is.
        await db.updateClip(clip.id, { needsReview: false });
        await deps.deliverQueue.add({ clipId: clip.id }, { jobId: `deliver_${clip.id}` });
        return;
      }
      if (!moment) throw new Error('approve: clip has no moment');
      const title = typeof p.title === 'string' && p.title.trim() ? p.title.trim() : clip.chosenTitle;
      await db.updateMoment(moment.id, { status: 'approved' });
      if (title && title !== clip.burnedTitle) {
        await db.updateClip(clip.id, { chosenTitle: title });
        const job: RenderJob = { momentId: moment.id, startTs: moment.startTs, endTs: moment.endTs, reason: 'title', titleOverride: title, thenDeliver: true };
        await deps.renderQueue.add(job, { jobId: renderJobId(job) });
      } else {
        await deps.deliverQueue.add({ clipId: clip.id }, { jobId: `deliver_${clip.id}` });
      }
      return;
    }
    case 'reject': {
      if (!moment) throw new Error('reject: no moment');
      await db.updateMoment(moment.id, { status: 'rejected' });
      return;
    }
    case 'title': {
      if (!clip) throw new Error('title: no clip');
      const title = String(p.title ?? '').trim();
      if (!title) throw new Error('title: empty');
      await db.updateClip(clip.id, { chosenTitle: title });
      return;
    }
    case 'trim': {
      if (!moment) throw new Error('trim: no moment');
      const ds = clamp(Number(p.startDeltaS ?? 0), -MAX_TRIM_S, MAX_TRIM_S);
      const de = clamp(Number(p.endDeltaS ?? 0), -MAX_TRIM_S, MAX_TRIM_S);
      let startTs = moment.startTs + ds * 1000;
      let endTs = moment.endTs + de * 1000;
      if (moment.source) {
        startTs = Math.max(startTs, moment.source.startTs);
        endTs = Math.min(endTs, moment.source.endTs);
      }
      const maxClip = 180_000; // Shorts allow 3 minutes; the scorer keeps auto clips ≤ 60s
      if (endTs - startTs < 3000) throw new Error('trim: clip would be shorter than 3s');
      if (endTs - startTs > maxClip) endTs = startTs + maxClip;
      await db.updateMoment(moment.id, { startTs, endTs, status: 'rendering' });
      const job: RenderJob = { momentId: moment.id, startTs, endTs, reason: 'trim', titleOverride: clip?.chosenTitle ?? null };
      await deps.renderQueue.add(job, { jobId: renderJobId(job) });
      return;
    }
    case 'rerender': {
      if (!moment) throw new Error('rerender: no moment');
      await db.updateMoment(moment.id, { status: 'rendering' });
      const job: RenderJob = { momentId: moment.id, startTs: moment.startTs, endTs: moment.endTs, reason: 'rerender', titleOverride: clip?.chosenTitle ?? null };
      await deps.renderQueue.add(job, { jobId: renderJobId(job) });
      return;
    }
    case 'premium': {
      if (!moment) throw new Error('premium: no moment');
      await db.updateMoment(moment.id, { status: 'premium' });
      await deps.premiumQueue.add({ momentId: moment.id, requestedBy: a.operatorEmail }, { jobId: `premium_${moment.id}` });
      return;
    }
    case 'deliver': {
      if (!clip) throw new Error('deliver: no clip');
      await deps.deliverQueue.add({ clipId: clip.id }, { jobId: `deliver_${clip.id}_${a.id}` });
      return;
    }
  }
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

export class ActionProcessor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;
  private unsub: (() => void) | null = null;

  constructor(
    private deps: WorkerDeps,
    private pollMs = 3000,
  ) {}

  start() {
    this.timer = setInterval(() => void this.runOnce(), this.pollMs);
    this.timer.unref();
    this.unsub = this.deps.db.onOperatorAction?.(() => void this.runOnce()) ?? null;
    void this.runOnce();
  }

  async runOnce() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const actions = await this.deps.db.claimOperatorActions(this.deps.host, 20);
        for (const a of actions) {
          try {
            await handleAction(this.deps, a);
            await this.deps.db.completeOperatorAction(a.id, null);
            this.deps.metrics.inc(`action_${a.action}`);
          } catch (err) {
            this.deps.log.warn({ action: a.action, id: a.id, err: (err as Error).message }, 'operator action failed');
            await this.deps.db.completeOperatorAction(a.id, (err as Error).message);
          }
        }
        if (actions.length === 20) this.again = true;
      } while (this.again);
    } catch (err) {
      this.deps.log.error({ err: (err as Error).message }, 'action poll failed');
    } finally {
      this.running = false;
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.unsub?.();
  }
}
