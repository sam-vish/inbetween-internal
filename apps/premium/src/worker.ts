/**
 * Premium worker: consumes the `premium` queue (filled when operators press
 * "Send to premium") and runs one Claude Code + HyperFrames job at a time.
 * Needs Redis (the queue is shared with the main worker) and the `claude`
 * CLI + HyperFrames installed on this machine.
 */
import { loadEnv } from '@inbetween/shared';
import { createDeps, type PremiumJob } from '@inbetween/worker';
import { runPremiumJob } from './premium';

const env = loadEnv();
if (!env.REDIS_URL) {
  console.error('premium worker needs REDIS_URL (the premium queue is shared with the main worker)');
  process.exit(1);
}
const deps = await createDeps(env);
const concurrency = Number(process.env.PREMIUM_CONCURRENCY ?? 1);
deps.premiumQueue.process(async (job: PremiumJob) => {
  deps.log.info({ momentId: job.momentId, by: job.requestedBy }, 'premium job started');
  try {
    await runPremiumJob(deps, job.momentId);
  } catch (err) {
    void deps.alerter.alert(`premium-${job.momentId}`, `Premium edit failed for moment ${job.momentId}: ${(err as Error).message}`, { level: 'error', dedupe: false });
    throw err;
  }
}, concurrency);
deps.log.info({ concurrency }, 'premium worker up');

const stop = async () => {
  await deps.close();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
