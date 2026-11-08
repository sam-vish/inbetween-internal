/**
 * Weekly compilation (PRD 4.9): a long-form 16:9 highlights video for the
 * client's channel from approved clips, with chapter cards and short fades.
 * The result is stored as a `compilation` clip with needs_review = true
 * (deliver it from the client page after review) and the YouTube chapter
 * list is printed for the description.
 *
 *   pnpm --filter @inbetween/premium compile --client <clientId> [--days 7] [--max 20]
 *   pnpm --filter @inbetween/premium compile --all [--days 7]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { compilationArgs, probeMedia, runProcess } from '@inbetween/render';
import { formatOffset, loadEnv, storageKeys, type MomentRecord } from '@inbetween/shared';
import { createDeps, type WorkerDeps } from '@inbetween/worker';
import { JOBS_DIR } from './premium';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export async function compileForClient(deps: WorkerDeps, clientId: string, days = 7, max = 20) {
  const client = await deps.db.getClient(clientId);
  if (!client) throw new Error(`client ${clientId} not found`);
  const since = Date.now() - days * 24 * 3600_000;
  const moments = (await deps.db.listMomentsForClient(clientId, since, ['approved', 'delivered', 'premium']))
    .filter((m) => m.source?.key)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .sort((a, b) => a.eventTs - b.eventTs);
  if (!moments.length) {
    deps.log.info({ client: client.name }, 'no approved moments for a compilation');
    return null;
  }
  const label = `week-${new Date().toISOString().slice(0, 10)}`;
  const dir = path.join(JOBS_DIR, 'compilations', client.id, label);
  await fs.mkdir(dir, { recursive: true });
  const items = [];
  const chapters: string[] = [];
  let cursor = 0;
  for (const [i, m] of moments.entries()) {
    const src = path.join(dir, `src-${i}.ts`);
    await deps.storage.download(m.source!.key!, src);
    const fast = await deps.db.getLatestClip(m.id, 'fast');
    const title = (fast?.chosenTitle ?? m.label ?? `Moment ${i + 1}`).replace(/[\p{Extended_Pictographic}️]/gu, '').trim();
    const titleFile = path.join(dir, `title-${i}.txt`);
    await fs.writeFile(titleFile, title);
    const durationS = (m.endTs - m.startTs) / 1000;
    items.push({ source: src, offsetS: Math.max(0, (m.startTs - m.source!.startTs) / 1000), durationS, titleFile });
    chapters.push(`${formatOffset(cursor)} ${title}`);
    cursor += 2 + durationS;
  }
  const out = path.join(dir, `${label}.mp4`);
  await runProcess(deps.env.FFMPEG_BIN, compilationArgs(items, out, { preset: deps.env.X264_PRESET }), { timeoutMs: 60 * 60_000 });
  const info = await probeMedia(deps.env.FFPROBE_BIN, out);
  const key = storageKeys.compilation(client.id, label);
  await deps.storage.put(key, out, 'video/mp4');
  const clip = await deps.db.insertClip({
    momentId: null,
    clientId: client.id,
    streamId: null,
    kind: 'compilation',
    r2Key: key,
    thumbKey: null,
    sourceKey: null,
    titles: [`${client.name} — best of the week`],
    chosenTitle: `${client.name} — best of the week`,
    burnedTitle: null,
    language: client.config.caption_language,
    durationS: info.durationS,
    renderMs: 0,
    startTs: moments[0].startTs,
    endTs: moments.at(-1)!.endTs,
    needsReview: true,
  });
  await fs.writeFile(path.join(dir, 'chapters.txt'), chapters.join('\n'));
  for (const it of items) await fs.rm(it.source, { force: true });
  return { clipId: clip.id, out, chapters, moments: moments.map((m: MomentRecord) => m.id) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const deps = await createDeps(loadEnv());
  const days = Number(arg('days') ?? 7);
  const max = Number(arg('max') ?? 20);
  const ids = process.argv.includes('--all') ? (await deps.db.listActiveClients()).map((c) => c.id) : [arg('client')].filter(Boolean) as string[];
  if (!ids.length) {
    console.error('usage: compile --client <id> | --all [--days 7] [--max 20]');
    process.exit(2);
  }
  for (const id of ids) {
    const r = await compileForClient(deps, id, days, max).catch((err) => {
      console.error(`compilation failed for ${id}: ${(err as Error).message}`);
      return null;
    });
    if (r) console.log(`client ${id}: ${r.out}\nYouTube chapters:\n${r.chapters.join('\n')}\n`);
  }
  await deps.close();
  process.exit(0);
}
