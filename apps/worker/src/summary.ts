/** End-of-stream summary (PRD 4.7 / 4.8): stored on the stream row and sent to the client. */
import type { ClientRecord, StreamRecord, StreamSummary } from '@inbetween/shared';
import type { WorkerDeps } from './deps';

export async function buildStreamSummary(deps: WorkerDeps, stream: StreamRecord, endedAt: number): Promise<StreamSummary> {
  const moments = (await deps.db.listMoments(stream.id)).filter((m) => m.status !== 'failed');
  const count = (...s: string[]) => moments.filter((m) => s.includes(m.status)).length;
  const approved = count('approved', 'delivered');
  const rejected = count('rejected');
  const reviewed = approved + rejected;
  const costUsd = Math.max(await deps.db.sumCost({ streamId: stream.id }).catch(() => 0), deps.costs.streamTotal(stream.id));
  const durationS = Math.max(1, Math.round((endedAt - stream.startedAt) / 1000));
  return {
    moments: moments.length,
    approved,
    rejected,
    delivered: count('delivered'),
    premium: count('premium'),
    approvalRate: reviewed ? approved / reviewed : 0,
    costUsd: Math.round(costUsd * 10000) / 10000,
    quotaUnits: deps.quota.streamUnits(stream.id),
    durationS,
    costPerHourUsd: Math.round((costUsd / (durationS / 3600)) * 10000) / 10000,
  };
}

export function summaryText(client: ClientRecord, s: StreamSummary): string {
  const hours = (s.durationS / 3600).toFixed(1);
  return `Stream ended (${hours}h): ${s.moments} moments, ${s.approved} clips approved, ${s.premium} queued for premium.`;
}

export async function sendStreamSummary(deps: WorkerDeps, client: ClientRecord, s: StreamSummary) {
  try {
    const { deliverer, target } = deps.delivery.for(client.delivery);
    await deliverer.sendText(target, summaryText(client, s));
  } catch (err) {
    deps.log.warn({ err: (err as Error).message, client: client.name }, 'summary delivery failed');
  }
}
