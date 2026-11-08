/** Delivery job (PRD 4.8): send an approved clip to the client's target. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatOffset } from '@inbetween/shared';
import type { WorkerDeps } from '../deps';
import type { DeliverJob } from '../queue/index';

export async function processDeliverJob(deps: WorkerDeps, job: DeliverJob): Promise<void> {
  const clip = await deps.db.getClip(job.clipId);
  if (!clip) return;
  const client = await deps.db.getClient(clip.clientId);
  if (!client) return;
  const moment = clip.momentId ? await deps.db.getMoment(clip.momentId) : null;
  const stream = clip.streamId ? await deps.db.getStream(clip.streamId) : null;

  const local = path.join(deps.dataDir, 'deliver-tmp', `${clip.id}.mp4`);
  await deps.storage.download(clip.r2Key, local);
  const offsetS = moment && stream ? (moment.startTs - stream.startedAt) / 1000 : 0;
  const adapter = stream && deps.adapters.has(stream.platform) ? deps.adapters.get(stream.platform) : null;
  const streamUrl =
    stream && adapter?.timestampUrl
      ? adapter.timestampUrl(
          { platform: stream.platform, channelId: client.youtubeChannelId, videoId: stream.videoId, liveChatId: stream.liveChatId, title: stream.title, startedAt: stream.startedAt, url: '' },
          offsetS,
        )
      : null;

  const { deliverer, target } = deps.delivery.for(client.delivery);
  const rec = await deps.db.insertDelivery({ clipId: clip.id, clientId: client.id, targetType: client.delivery.type, status: 'pending', detail: null });
  try {
    const res = await deliverer.sendClip(target, {
      clientName: client.name,
      chosenTitle: clip.chosenTitle ?? clip.titles[0] ?? 'Clip',
      titles: clip.titles,
      videoPath: local,
      videoUrl: await deps.storage.getUrl(clip.r2Key),
      thumbUrl: clip.thumbKey ? await deps.storage.getUrl(clip.thumbKey) : null,
      durationS: clip.durationS,
      streamOffsetLabel: formatOffset(offsetS),
      streamUrl,
      momentLabel: moment?.label ?? moment?.visionLabel ?? null,
      kind: clip.kind,
    });
    await deps.db.updateDelivery(rec.id, { status: 'sent', detail: res.detail });
    if (moment && clip.kind === 'fast') await deps.db.updateMoment(moment.id, { status: 'delivered' });
    if (clip.needsReview) await deps.db.updateClip(clip.id, { needsReview: false });
    deps.metrics.inc('clips_delivered');
    deps.log.info({ clipId: clip.id, client: client.name, mode: res.mode }, 'clip delivered');
  } catch (err) {
    await deps.db.updateDelivery(rec.id, { status: 'failed', detail: (err as Error).message.slice(0, 500) });
    throw err;
  } finally {
    await fs.rm(local, { force: true });
  }
}
