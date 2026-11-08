/**
 * Composition root: builds every dependency from the environment. This is
 * where implementations are chosen (Supabase vs memory, R2 vs local, Redis
 * vs in-process, real vs mock providers).
 */
import path from 'node:path';
import { type AdapterRegistry, createAdapterRegistry } from '@inbetween/adapters';
import { DeliveryRouter } from '@inbetween/delivery';
import { createProviders, type Providers } from '@inbetween/providers';
import {
  CostTracker,
  createDb,
  createRedis,
  createStorage,
  type Db,
  DefaultOpsAlerter,
  type Env,
  getLogger,
  type Logger,
  type ObjectStorage,
  type OpsAlerter,
  Pricing,
  QuotaLedger,
  type Redis,
} from '@inbetween/shared';
import { MemoryBus, RedisStreamBus, type SignalBus } from './bus/index';
import { Metrics } from './metrics';
import { createQueue, type DeliverJob, type JobQueue, type PremiumJob, type RenderJob } from './queue/index';

export interface WorkerDeps {
  env: Env;
  log: Logger;
  host: string;
  dataDir: string;
  db: Db;
  storage: ObjectStorage;
  redis: Redis | null;
  pricing: Pricing;
  quota: QuotaLedger;
  costs: CostTracker;
  alerter: OpsAlerter;
  adapters: AdapterRegistry;
  providers: Providers;
  bus: SignalBus;
  renderQueue: JobQueue<RenderJob>;
  deliverQueue: JobQueue<DeliverJob>;
  premiumQueue: JobQueue<PremiumJob>;
  delivery: DeliveryRouter;
  metrics: Metrics;
  close(): Promise<void>;
}

export interface DepsOverrides {
  db?: Db;
  storage?: ObjectStorage;
  providers?: Providers;
  adapters?: AdapterRegistry;
  redis?: Redis | null;
  fetchImpl?: typeof fetch;
}

export function renderQueueName(host: string) {
  return `render@${host.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export async function createDeps(env: Env, o: DepsOverrides = {}): Promise<WorkerDeps> {
  const log = getLogger('worker');
  const host = env.WORKER_HOST_ID;
  const dataDir = path.resolve(env.DATA_DIR);
  const db = o.db ?? createDb(env);
  if (db.kind === 'memory') log.warn('DB: in-memory (set SUPABASE_URL + SUPABASE_SERVICE_KEY for production)');
  const storage = o.storage ?? createStorage(env);
  const redis = o.redis !== undefined ? o.redis : createRedis(env.REDIS_URL, { forBullMq: true });
  if (!redis) log.warn('Redis: not configured, using in-process bus + queues (single process only)');
  const pricing = new Pricing(env.PRICING_OVERRIDES_JSON);
  const alerter = new DefaultOpsAlerter({
    log: log.child({ mod: 'alerts' }),
    discordWebhookUrl: env.OPS_DISCORD_WEBHOOK_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.OPS_TELEGRAM_CHAT_ID,
  });
  const quota = new QuotaLedger({
    db,
    redis,
    dailyLimit: env.YOUTUBE_DAILY_QUOTA,
    log: log.child({ mod: 'quota' }),
    onAlert: (level, used, limit) => {
      const pct = Math.round((used / limit) * 100);
      const msg =
        level === 'alert'
          ? `YouTube API quota at ${pct}% (${used}/${limit} units today).`
          : level === 'fallback'
            ? `YouTube API quota at ${pct}%: new streams start in fallback mode (no API chat).`
            : `YouTube API quota exhausted (${used}/${limit}). API calls are being refused until midnight PT.`;
      void alerter.alert(`quota-${level}`, msg, { level: level === 'alert' ? 'warn' : 'error' });
    },
  });
  const costs = new CostTracker(db, pricing, log.child({ mod: 'cost' }));
  const adapters = o.adapters ?? createAdapterRegistry({ env, quota, log, fetchImpl: o.fetchImpl });
  await adapters.init();
  const providers = o.providers ?? createProviders(env, pricing);
  log.info(
    { asr: providers.asr?.name ?? 'none', liveAsr: providers.liveAsr?.name ?? 'none', vision: providers.vision?.name ?? 'none', llm: providers.llm.name, db: db.kind, storage: storage.kind },
    'providers',
  );
  const bus: SignalBus = redis ? new RedisStreamBus(redis, log.child({ mod: 'bus' })) : new MemoryBus();
  const renderQueue = createQueue<RenderJob>(renderQueueName(host), redis, log);
  const deliverQueue = createQueue<DeliverJob>('deliver', redis, log);
  const premiumQueue = createQueue<PremiumJob>('premium', redis, log);
  const delivery = new DeliveryRouter({
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    googleServiceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    discordMaxUploadMb: env.DISCORD_MAX_UPLOAD_MB,
    telegramMaxUploadMb: env.TELEGRAM_MAX_UPLOAD_MB,
    localDir: path.join(dataDir, 'deliveries'),
    log: log.child({ mod: 'delivery' }),
  });

  return {
    env,
    log,
    host,
    dataDir,
    db,
    storage,
    redis,
    pricing,
    quota,
    costs,
    alerter,
    adapters,
    providers,
    bus,
    renderQueue,
    deliverQueue,
    premiumQueue,
    delivery,
    metrics: new Metrics(),
    async close() {
      await Promise.allSettled([renderQueue.close(), deliverQueue.close(), premiumQueue.close()]);
      await bus.close();
      await quota.close();
      await costs.close();
      adapters.close();
      await db.close?.();
      redis?.disconnect();
    },
  };
}
