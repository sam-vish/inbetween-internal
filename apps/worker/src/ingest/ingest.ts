/**
 * Ingest worker (PRD 4.2). One ffmpeg process per ingest session reads the
 * live MPEG-TS (from streamlink/yt-dlp stdout, or a file in replay) and
 * writes three outputs without re-encoding the video:
 *   1. 2s MPEG-TS segments (`-c copy`) + a live CSV segment list
 *   2. 16 kHz mono s16le PCM on stdout (audio_loud + voice ASR)
 *   3. 480p JPEG frames at 1 fps (vision + dashboard crop tester)
 *
 * Media time is anchored to the stream clock when the first PCM bytes
 * arrive. On a drop the worker emits `drop`; the pipeline decides whether to
 * reconnect (with backoff) or end the session. One bad segment never
 * crashes the process: ffmpeg runs with +discardcorrupt and errors restart
 * the session.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Clock, HlsSource, Logger } from '@inbetween/shared';
import type { RollingBuffer } from './buffer';

export interface FrameRef {
  path: string;
  ts: number;
}

export interface IngestOptions {
  source: HlsSource;
  dir: string;
  clock: Clock;
  buffer: RollingBuffer;
  ffmpegBin: string;
  log: Logger;
  frameFps?: number;
  /** Seconds added to every media timestamp (PRD "Latency mode" tuning knob). */
  videoOffsetS?: number;
  segmentTimeS?: number;
  /** Keep this many seconds of frames on disk. */
  frameRetentionS?: number;
}

export interface IngestEvents {
  audio: [chunk: Buffer, anchorTs: number, session: number];
  segment: [seg: { path: string; startTs: number; endTs: number }];
  frame: [frame: FrameRef];
  drop: [info: { session: number; code: number | null; stderr: string; ranMs: number }];
  ended: [];
}

export class IngestWorker extends EventEmitter<IngestEvents> {
  private session = 0;
  private ff: ChildProcess | null = null;
  private src: ChildProcess | null = null;
  private poll: NodeJS.Timeout | null = null;
  private stopped = false;
  private anchorTs: number | null = null;
  private csvOffset = 0;
  private csvPartial = '';
  private nextFrame = 1;
  private frames: FrameRef[] = [];
  private noAudio = false;
  private startedAt = 0;
  stats = { sessions: 0, segments: 0, frames: 0, audioBytes: 0, drops: 0 };

  constructor(private o: IngestOptions) {
    super();
  }

  get currentSession() {
    return this.session;
  }

  latestFrame(): FrameRef | null {
    return this.frames.at(-1) ?? null;
  }

  framesBetween(fromTs: number, toTs: number): FrameRef[] {
    return this.frames.filter((f) => f.ts >= fromTs && f.ts <= toTs);
  }

  private ffmpegArgs(input: string[], s: number): string[] {
    const segDir = path.join(this.o.dir, 'seg');
    const frameDir = path.join(this.o.dir, 'frames');
    const fps = this.o.frameFps ?? 1;
    const args = [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-nostdin',
      '-fflags',
      '+genpts+discardcorrupt',
      ...input,
      // 1) segments
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      '-f',
      'segment',
      '-segment_time',
      String(this.o.segmentTimeS ?? 2),
      '-segment_format',
      'mpegts',
      '-segment_list',
      path.join(segDir, `s${s}.csv`),
      '-segment_list_type',
      'csv',
      '-segment_list_flags',
      '+live',
      '-reset_timestamps',
      '0',
      path.join(segDir, `s${s}_%06d.ts`),
    ];
    if (!this.noAudio) args.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1');
    args.push('-map', '0:v:0', '-an', '-vf', `fps=${fps},scale=-2:480`, '-q:v', '6', '-f', 'image2', path.join(frameDir, `f${s}_%07d.jpg`));
    return args;
  }

  async start() {
    this.stopped = false;
    await fsp.mkdir(path.join(this.o.dir, 'seg'), { recursive: true });
    await fsp.mkdir(path.join(this.o.dir, 'frames'), { recursive: true });
    this.launch();
  }

  /** Starts a new ingest session (after a drop). */
  restart() {
    if (this.stopped) return;
    this.launch();
  }

  private launch() {
    this.cleanupProcs();
    const s = ++this.session;
    this.stats.sessions++;
    this.anchorTs = null;
    this.csvOffset = 0;
    this.csvPartial = '';
    this.nextFrame = 1;
    this.startedAt = Date.now();

    const src = this.o.source;
    let input: string[];
    if (src.kind === 'file') {
      input = src.speed && src.speed > 0 ? ['-readrate', String(src.speed), '-i', src.path] : ['-i', src.path];
    } else {
      input = ['-i', 'pipe:0'];
    }
    const ff = spawn(this.o.ffmpegBin, this.ffmpegArgs(input, s), { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ff = ff;
    let stderr = '';
    ff.stderr!.on('data', (d) => {
      stderr = (stderr + d).slice(-8000);
    });
    ff.stdout!.on('data', (chunk: Buffer) => {
      if (this.anchorTs == null) {
        this.anchorTs = this.o.clock.now() + (this.o.videoOffsetS ?? 0) * 1000;
        this.o.log.info({ session: s }, 'ingest: first media received');
      }
      this.stats.audioBytes += chunk.length;
      this.emit('audio', chunk, this.anchorTs, s);
    });
    ff.stdin!.on('error', () => {
      /* source closed */
    });

    if (src.kind === 'command') {
      const child = spawn(src.cmd, src.args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...src.env } });
      this.src = child;
      child.stdout!.pipe(ff.stdin!);
      let srcErr = '';
      child.stderr!.on('data', (d) => {
        srcErr = (srcErr + d).slice(-4000);
      });
      child.on('error', (err) => this.o.log.error({ err: err.message }, 'ingest: source process failed to start'));
      child.on('close', (code) => {
        if (code && !this.stopped) this.o.log.warn({ code, srcErr: srcErr.trim().slice(-500) }, 'ingest: source exited');
        ff.stdin?.end();
      });
    } else {
      ff.stdin!.end();
    }

    ff.on('error', (err) => this.o.log.error({ err: err.message }, 'ingest: ffmpeg failed to start'));
    ff.on('close', (code) => {
      void this.drainOnce(s, true).then(() => {
        if (this.ff !== ff) return;
        this.ff = null;
        if (this.stopped) return;
        if (!this.noAudio && /does not contain any stream|Stream map '0:a:0' matches no streams/i.test(stderr)) {
          this.o.log.warn('ingest: source has no audio; continuing video-only');
          this.noAudio = true;
          this.launch();
          return;
        }
        if (src.kind === 'file' && code === 0) {
          this.emit('ended');
          return;
        }
        this.stats.drops++;
        this.emit('drop', { session: s, code, stderr: stderr.slice(-1500), ranMs: Date.now() - this.startedAt });
      });
    });

    if (!this.poll) {
      this.poll = setInterval(() => void this.drainOnce(this.session), 400);
      this.poll.unref();
    }
  }

  private drainChain: Promise<void> = Promise.resolve();
  private drainQueued = false;

  /** Reads new segment-list lines and newly completed frames (serialized). */
  private drainOnce(s: number, force = false): Promise<void> {
    if (this.drainQueued && !force) return this.drainChain;
    this.drainQueued = true;
    this.drainChain = this.drainChain.then(async () => {
      this.drainQueued = false;
      try {
        await this.readSegments(s);
        await this.readFrames(s);
      } catch (err) {
        this.o.log.debug({ err: (err as Error).message }, 'ingest drain error');
      }
    });
    return this.drainChain;
  }

  private async readSegments(s: number) {
    if (this.anchorTs == null) return;
    const csv = path.join(this.o.dir, 'seg', `s${s}.csv`);
    let fh: fsp.FileHandle | null = null;
    try {
      fh = await fsp.open(csv, 'r');
    } catch {
      return;
    }
    try {
      const { size } = await fh.stat();
      if (size <= this.csvOffset) return;
      const buf = Buffer.alloc(size - this.csvOffset);
      await fh.read(buf, 0, buf.length, this.csvOffset);
      this.csvOffset = size;
      const text = this.csvPartial + buf.toString('utf8');
      const lines = text.split('\n');
      this.csvPartial = lines.pop() ?? '';
      for (const line of lines) {
        const [file, start, end] = line.trim().split(',');
        if (!file || start == null || end == null) continue;
        const seg = {
          path: path.join(this.o.dir, 'seg', file),
          startTs: Math.round(this.anchorTs + Number(start) * 1000),
          endTs: Math.round(this.anchorTs + Number(end) * 1000),
        };
        this.o.buffer.add({ ...seg, session: s, index: this.stats.segments });
        this.stats.segments++;
        this.emit('segment', seg);
      }
    } finally {
      await fh.close();
    }
  }

  private async readFrames(s: number) {
    if (this.anchorTs == null) return;
    const fps = this.o.frameFps ?? 1;
    const dir = path.join(this.o.dir, 'frames');
    // A frame is complete once the next one exists (or the process has exited).
    for (;;) {
      const cur = path.join(dir, `f${s}_${String(this.nextFrame).padStart(7, '0')}.jpg`);
      const next = path.join(dir, `f${s}_${String(this.nextFrame + 1).padStart(7, '0')}.jpg`);
      const exited = this.ff == null || this.session !== s;
      if (!fs.existsSync(cur) || (!exited && !fs.existsSync(next))) break;
      const f = { path: cur, ts: Math.round(this.anchorTs + ((this.nextFrame - 1) / fps) * 1000) };
      this.frames.push(f);
      this.stats.frames++;
      this.emit('frame', f);
      this.nextFrame++;
    }
    const keepFrom = this.o.clock.now() - (this.o.frameRetentionS ?? 120) * 1000;
    while (this.frames.length && this.frames[0].ts < keepFrom) {
      const old = this.frames.shift()!;
      void fsp.rm(old.path, { force: true });
    }
  }

  private cleanupProcs() {
    if (this.src && this.src.exitCode == null) this.src.kill('SIGTERM');
    if (this.ff && this.ff.exitCode == null) this.ff.kill('SIGTERM');
    this.src = null;
    this.ff = null;
  }

  async stop() {
    this.stopped = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    const ff = this.ff;
    this.cleanupProcs();
    if (ff && ff.exitCode == null) {
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          ff.kill('SIGKILL');
          r();
        }, 3000);
        ff.once('close', () => {
          clearTimeout(t);
          r();
        });
      });
    }
    await this.drainOnce(this.session, true);
  }

  async removeFrames() {
    for (const f of this.frames) await fsp.rm(f.path, { force: true });
    this.frames = [];
    await fsp.rm(path.join(this.o.dir, 'frames'), { recursive: true, force: true });
  }
}
