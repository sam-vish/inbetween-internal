/**
 * Worker entry point.
 *   WORKER_ROLE=all     ingest + render + actions + delivery (default; one box)
 *   WORKER_ROLE=ingest  go-live + pipelines + actions
 *   WORKER_ROLE=render  render + delivery only
 */
import { loadEnv } from '@inbetween/shared';
import { ActionProcessor } from './actions/processor';
import { createDeps } from './deps';
import { processDeliverJob } from './delivery/deliver';
import { startHttp, subscribeWebSub } from './http';
import { scheduleJanitor } from './janitor';
import { processRenderJob } from './render/fast-lane';
import { Supervisor } from './supervisor';

async function main() {
  const env = loadEnv();
  const deps = await createDeps(env);
  const role = env.WORKER_ROLE;
  const maxStreams = Number(process.env.MAX_STREAMS ?? 6);

  if (role === 'all' || role === 'render') {
    deps.renderQueue.process((job) => processRenderJob(deps, job), env.RENDER_CONCURRENCY);
    deps.deliverQueue.process((job) => processDeliverJob(deps, job), 2);
  }
  let supervisor: Supervisor | null = null;
  let actions: ActionProcessor | null = null;
  if (role === 'all' || role === 'ingest') {
    supervisor = new Supervisor(deps, { maxStreams });
    await supervisor.start();
    actions = new ActionProcessor(deps);
    actions.start();
    void subscribeWebSub(deps);
  }
  const stopJanitor = scheduleJanitor(deps);
  const server = startHttp(deps, supervisor);
  deps.log.info({ role, host: deps.host, maxStreams }, 'inbetween worker up');

  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log.info({ sig }, 'shutting down');
    stopJanitor();
    actions?.stop();
    await supervisor?.stop();
    server.close();
    await deps.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => deps.log.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => deps.log.fatal({ err }, 'uncaught exception'));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
