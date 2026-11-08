/**
 * End-to-end check, fully offline: synthetic stream → ingest → signals →
 * scorer → clipper → fast-lane render (mock ASR/LLM) → approve → delivery.
 *
 * Asserts:
 *  - every ground-truth event produces exactly one moment (event time ±3s)
 *  - the Super Chat TTS decoy produces no moment
 *  - each moment has a 1080×1920 clip with audio, 15–60s long
 *  - approved clips land in the local delivery folder
 *
 *   tsx scripts/e2e.ts [--speed 2] [--duration 240]
 */
import fs from 'node:fs';
import path from 'node:path';
import { probeMedia } from '@inbetween/render';
import { makeSynthetic } from './make-synthetic';
import { runReplay } from './replay';

function arg(name: string, def: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

const dataDir = path.resolve(arg('data', 'data/e2e'));
fs.rmSync(dataDir, { recursive: true, force: true });
const synthDir = path.join(dataDir, 'synthetic');
const truth = makeSynthetic(synthDir, Number(arg('duration', '240')));
const speed = Number(arg('speed', '2'));

process.env.LOG_LEVEL ??= 'warn';
const report = await runReplay({
  video: path.join(synthDir, 'vod.mp4'),
  chatFile: path.join(synthDir, 'chat.jsonl'),
  name: 'E2E Creator',
  clientConfig: { caption_language: 'hinglish', layout_preset: 'stack', facecam_rect: { x: 70, y: 0, w: 30, h: 30 } },
  speed,
  memory: true,
  useRedis: process.argv.includes('--redis'),
  autoApprove: true,
  dataDir,
});

const failures: string[] = [];
for (const e of truth.events) {
  const hits = report.moments.filter((m) => Math.abs(m.eventOffsetS - e) <= 3);
  if (hits.length !== 1) failures.push(`event at ${e}s: expected 1 moment, got ${hits.length}`);
}
const decoy = report.moments.filter((m) => m.eventOffsetS >= truth.paidDecoy - 5 && m.eventOffsetS <= truth.paidDecoy + 15);
if (decoy.length) failures.push(`Super Chat decoy at ${truth.paidDecoy}s produced ${decoy.length} moment(s)`);
if (report.moments.length !== truth.events.length) failures.push(`expected ${truth.events.length} moments total, got ${report.moments.length}`);

for (const m of report.moments) {
  if (!m.clip) {
    failures.push(`moment ${m.eventOffsetS}s has no clip`);
    continue;
  }
  const info = await probeMedia('ffprobe', m.clip);
  if (info.width !== 1080 || info.height !== 1920) failures.push(`clip ${m.clip} is ${info.width}x${info.height}`);
  if (!info.hasAudio) failures.push(`clip ${m.clip} has no audio`);
  if (info.durationS < 15 || info.durationS > 60.5) failures.push(`clip ${m.clip} duration ${info.durationS}s`);
  if (m.status !== 'delivered') failures.push(`moment ${m.eventOffsetS}s status ${m.status}, expected delivered`);
  if (m.titles.length !== 3) failures.push(`moment ${m.eventOffsetS}s has ${m.titles.length} titles`);
}
const delivered = fs.existsSync(path.join(dataDir, 'deliveries')) ? fs.readdirSync(path.join(dataDir, 'deliveries')).filter((f) => f.endsWith('.mp4')) : [];
if (delivered.length !== truth.events.length) failures.push(`expected ${truth.events.length} delivered files, found ${delivered.length}`);

console.log(
  JSON.stringify(
    {
      truth,
      speed,
      moments: report.moments.map((m) => ({ eventS: m.eventOffsetS, windowS: [m.startOffsetS, m.endOffsetS], score: m.score, status: m.status, title: m.titles[0], renderMs: m.renderMs, reason: m.reason })),
      latency_stream_time: report.latency,
      signalRows: report.signalRows,
      delivered: delivered.length,
      wallS: report.wallS,
    },
    null,
    2,
  ),
);
if (failures.length) {
  console.error(`E2E FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
console.log('E2E PASSED');
process.exit(0);
