/** Child-process runner for ffmpeg/ffprobe with timeouts and stderr capture. */
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stderr: string;
  stdout: string;
  ms: number;
}

export class FfmpegError extends Error {
  constructor(
    readonly bin: string,
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(`${bin} exited ${code}: ${stderr.trim().split('\n').slice(-6).join(' | ')}`);
    this.name = 'FfmpegError';
  }
}

export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal; cwd?: string; input?: Buffer } = {},
): Promise<RunResult> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: [opts.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout!.on('data', (d) => {
      stdout += d;
      if (stdout.length > 4_000_000) stdout = stdout.slice(-4_000_000);
    });
    child.stderr!.on('data', (d) => {
      stderr += d;
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null;
    const onAbort = () => child.kill('SIGKILL');
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.input) child.stdin!.end(opts.input);
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve({ code, stderr, stdout, ms: Date.now() - t0 });
      else reject(new FfmpegError(bin, code, stderr));
    });
  });
}

export interface ProbeInfo {
  durationS: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  fps: number | null;
}

export async function probeMedia(ffprobeBin: string, file: string): Promise<ProbeInfo> {
  const { stdout } = await runProcess(
    ffprobeBin,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: 30_000 },
  );
  const j = JSON.parse(stdout);
  const v = (j.streams ?? []).find((s: any) => s.codec_type === 'video');
  const a = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
  const [num, den] = String(v?.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    durationS: Number(j.format?.duration ?? 0),
    width: v?.width ?? null,
    height: v?.height ?? null,
    hasAudio: !!a,
    fps: den ? num / den : null,
  };
}
