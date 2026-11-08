/**
 * Premium lane (PRD 4.9): post-stream motion-graphics edits.
 *
 * For one moment:
 *   1. job folder jobs/<momentId>/ with the 16:9 source (window ± 2s), the
 *      fast-lane vertical clip for reference, and transcript/labels/chat
 *   2. Claude writes brief.json (script + storyboard: hook, beats, callouts)
 *   3. Claude Code runs headless in apps/premium with the HyperFrames skills
 *      and the house `inbetween-edit` skill, and renders jobs/<id>/out/premium.mp4
 *   4. the result is uploaded as a `premium` clip with needs_review = true;
 *      an operator must approve it before it is delivered (human review is mandatory).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PremiumBrief } from '@inbetween/providers';
import { probeMedia, runProcess } from '@inbetween/render';
import { storageKeys } from '@inbetween/shared';
import type { WorkerDeps } from '@inbetween/worker';

export const PREMIUM_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const JOBS_DIR = path.join(PREMIUM_ROOT, 'jobs');

export interface PremiumJobResult {
  clipId: string | null;
  outPath: string | null;
  brief: PremiumBrief;
  log: string;
}

const ALLOWED_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash(npx hyperframes:*)',
  'Bash(ffmpeg:*)',
  'Bash(ffprobe:*)',
  'Bash(ls:*)',
  'Bash(mkdir:*)',
  'Bash(cp:*)',
].join(',');

export function claudeCodePrompt(jobRel: string): string {
  return [
    `Build the premium edit for the job in ${jobRel}/.`,
    `Read ${jobRel}/job.json and ${jobRel}/brief.json first. The raw footage is ${jobRel}/source.mp4 (16:9) and the fast-lane vertical cut is ${jobRel}/fast.mp4 for reference.`,
    'Use the HyperFrames skills and the inbetween-edit skill (see CLAUDE.md) to compose a 1080x1920, 30fps vertical edit that follows the storyboard beats: punch-ins on the peak, animated callouts (e.g. wanted-level stars), the hook text in the first 2 seconds, and readable captions.',
    `Render the final video to ${jobRel}/out/premium.mp4 with \`npx hyperframes render\`, verify it with ffprobe (1080x1920, has audio, duration within ±1s of the source window), and write a short ${jobRel}/out/notes.md describing what you did.`,
    'Do not publish anything and do not touch files outside this job folder and compositions/.',
  ].join('\n');
}

async function runClaudeCode(cwd: string, prompt: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  const bin = process.env.CLAUDE_CODE_BIN ?? 'claude';
  const extra = process.env.PREMIUM_CLAUDE_ARGS ? process.env.PREMIUM_CLAUDE_ARGS.split(' ').filter(Boolean) : [];
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools', ALLOWED_TOOLS, ...extra];
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    child.stdout.on('data', (d) => (output = (output + d).slice(-200_000)));
    child.stderr.on('data', (d) => (output = (output + d).slice(-200_000)));
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      resolve({ code: -1, output: `${output}\nspawn error: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, output });
    });
  });
}

export async function prepareJob(deps: WorkerDeps, momentId: string) {
  const m = await deps.db.getMoment(momentId);
  if (!m) throw new Error(`moment ${momentId} not found`);
  const client = await deps.db.getClient(m.clientId);
  const stream = await deps.db.getStream(m.streamId);
  if (!client || !stream) throw new Error('moment without client/stream');
  if (!m.source?.key) throw new Error('moment has no source clip (needed for premium)');
  const fast = await deps.db.getLatestClip(m.id, 'fast');

  const dir = path.join(JOBS_DIR, m.id);
  await fs.mkdir(path.join(dir, 'out'), { recursive: true });
  const rawSource = path.join(dir, 'source.ts');
  await deps.storage.download(m.source.key, rawSource);
  const padS = 2;
  const offsetS = Math.max(0, (m.startTs - m.source.startTs) / 1000 - padS);
  const durS = (m.endTs - m.startTs) / 1000 + 2 * padS;
  await runProcess(
    deps.env.FFMPEG_BIN,
    ['-y', '-hide_banner', '-loglevel', 'error', '-ss', offsetS.toFixed(3), '-i', rawSource, '-t', durS.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', path.join(dir, 'source.mp4')],
    { timeoutMs: 180_000 },
  );
  await fs.rm(rawSource, { force: true });
  if (fast) await deps.storage.download(fast.r2Key, path.join(dir, 'fast.mp4')).catch(() => undefined);

  const job = {
    momentId: m.id,
    client: { name: client.name, captionLanguage: client.config.caption_language, captionStyle: client.config.caption_style, layout: client.config.layout_preset, facecam: client.config.facecam_rect },
    game: client.config.game ?? stream.game,
    sourcePadS: padS,
    durationS: durS,
    transcript: m.transcript,
    label: m.label,
    visionLabel: m.visionLabel,
    chatSample: m.chatSample,
    titles: fast?.titles ?? [],
    chosenTitle: fast?.chosenTitle ?? null,
  };
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job, null, 2));
  return { m, client, stream, fast, dir, job };
}

export async function runPremiumJob(deps: WorkerDeps, momentId: string, opts: { skipClaudeCode?: boolean; timeoutMs?: number } = {}): Promise<PremiumJobResult> {
  const { m, client, stream, dir, job } = await prepareJob(deps, momentId);
  const cost = deps.costs.reporter({ clientId: client.id, streamId: stream.id });
  const brief = await deps.providers.llm.premiumBrief(
    {
      language: client.config.caption_language,
      creatorName: client.name,
      game: job.game,
      transcript: m.transcript ?? '',
      visionLabel: m.visionLabel,
      label: m.label,
      chatSample: m.chatSample,
      titles: job.titles,
      durationS: job.durationS,
    },
    cost,
  );
  await fs.writeFile(path.join(dir, 'brief.json'), JSON.stringify(brief, null, 2));
  if (opts.skipClaudeCode) return { clipId: null, outPath: null, brief, log: 'skipped Claude Code' };

  const rel = path.relative(PREMIUM_ROOT, dir);
  const r = await runClaudeCode(PREMIUM_ROOT, claudeCodePrompt(rel), opts.timeoutMs ?? 45 * 60_000);
  await fs.writeFile(path.join(dir, 'out', 'claude-code.log'), r.output);
  const out = path.join(dir, 'out', 'premium.mp4');
  const exists = await fs.stat(out).then((s) => s.size > 0).catch(() => false);
  if (!exists) throw new Error(`premium edit not produced (claude exit ${r.code}); see ${path.join(dir, 'out', 'claude-code.log')}`);
  const info = await probeMedia(deps.env.FFPROBE_BIN, out);

  const prev = await deps.db.getLatestClip(m.id, 'premium');
  const version = (prev ? Number(prev.r2Key.match(/premium-v(\d+)\.mp4$/)?.[1] ?? 0) : 0) + 1;
  const key = storageKeys.premium(client.id, m.id, version);
  await deps.storage.put(key, out, 'video/mp4');
  const clip = await deps.db.insertClip({
    momentId: m.id,
    clientId: client.id,
    streamId: stream.id,
    kind: 'premium',
    r2Key: key,
    thumbKey: null,
    sourceKey: m.source?.key ?? null,
    titles: [brief.hook, ...job.titles].slice(0, 3),
    chosenTitle: brief.hook,
    burnedTitle: brief.hook,
    language: client.config.caption_language,
    durationS: info.durationS,
    renderMs: 0,
    startTs: m.startTs,
    endTs: m.endTs,
    needsReview: true,
  });
  deps.log.info({ momentId: m.id, clipId: clip.id }, 'premium edit ready for review');
  return { clipId: clip.id, outPath: out, brief, log: r.output.slice(-2000) };
}
