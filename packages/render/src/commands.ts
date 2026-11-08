/**
 * ffmpeg argument builders. Pure functions (unit-tested); the worker runs them.
 */
import { buildLayoutGraph, type LayoutOptions } from './layout';

/** Escapes a path for use inside a filtergraph option value. */
export function filterPath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`;
}

export function concatListFile(paths: string[]): string {
  return paths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** Joins rolling-buffer segments into one MPEG-TS source clip without re-encoding. */
export function sourceClipArgs(listFile: string, out: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-map', '0', '-c', 'copy', '-f', 'mpegts', out];
}

export interface RenderArgsOptions extends LayoutOptions {
  input: string;
  output: string;
  offsetS: number;
  durationS: number;
  assPath?: string | null;
  fontsDir?: string | null;
  /** libx264 preset (not the layout preset). */
  x264Preset?: string;
  crf?: number;
  loudnorm?: boolean;
  threads?: number;
}

/** Cut + vertical layout + burned captions in one encode (1080×1920, 30fps). */
export function verticalRenderArgs(o: RenderArgsOptions): { args: string[]; captionY: number; effectivePreset: string } {
  const layout = buildLayoutGraph(o);
  let graph = layout.graph;
  let outPad = '[v]';
  if (o.assPath) {
    const fonts = o.fontsDir ? `:fontsdir=${filterPath(o.fontsDir)}` : '';
    graph += `;[v]ass=${filterPath(o.assPath)}${fonts}[vout]`;
    outPad = '[vout]';
  }
  const audio = o.loudnorm === false ? 'aresample=48000' : 'loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000';
  const args = [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    o.offsetS.toFixed(3),
    '-i',
    o.input,
    '-t',
    o.durationS.toFixed(3),
    '-filter_complex',
    graph,
    '-map',
    outPad,
    '-map',
    '0:a:0?',
    '-af',
    audio,
    '-c:v',
    'libx264',
    '-preset',
    o.x264Preset ?? 'veryfast',
    '-crf',
    String(o.crf ?? 21),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-g',
    '60',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    ...(o.threads ? ['-threads', String(o.threads)] : []),
    o.output,
  ];
  return { args, captionY: layout.captionY, effectivePreset: layout.effectivePreset };
}

/** 16 kHz mono WAV of a window, for caption ASR. */
export function audioExtractArgs(input: string, offsetS: number, durationS: number, out: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', offsetS.toFixed(3), '-i', input, '-t', durationS.toFixed(3), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out];
}

export function thumbnailArgs(input: string, atS: number, out: string, width = 540): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', atS.toFixed(3), '-i', input, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', out];
}

/** A single frame from a source at offset (for the dashboard's facecam crop tester). */
export function frameGrabArgs(input: string, atS: number, out: string): string[] {
  return ['-y', '-hide_banner', '-loglevel', 'error', '-ss', atS.toFixed(3), '-i', input, '-frames:v', '1', '-q:v', '3', out];
}

export interface CompilationItem {
  source: string;
  offsetS: number;
  durationS: number;
  /** Text file holding the chapter title (drawtext textfile= avoids escaping issues). */
  titleFile: string;
}

/**
 * Long-form 16:9 compilation: a 2s chapter card before each clip, short
 * fades in/out on every clip, concatenated into one MP4.
 */
export function compilationArgs(items: CompilationItem[], out: string, opts: { font?: string; preset?: string } = {}): string[] {
  const font = opts.font ?? 'Noto Sans';
  const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const it of items) args.push('-ss', it.offsetS.toFixed(3), '-t', it.durationS.toFixed(3), '-i', it.source);
  const parts: string[] = [];
  const concatInputs: string[] = [];
  items.forEach((it, i) => {
    const fadeOut = Math.max(0, it.durationS - 0.4).toFixed(3);
    parts.push(
      `color=c=0x111111:s=1920x1080:r=30:d=2,drawtext=font='${font}':textfile=${filterPath(it.titleFile)}:fontsize=76:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2,format=yuv420p,setsar=1[card${i}]`,
      `anullsrc=r=48000:cl=stereo,atrim=0:2[cardA${i}]`,
      `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p,setsar=1,fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.4[clip${i}]`,
      `[${i}:a]aresample=48000,aformat=channel_layouts=stereo,afade=t=in:st=0:d=0.3,afade=t=out:st=${fadeOut}:d=0.4[clipA${i}]`,
    );
    concatInputs.push(`[card${i}][cardA${i}][clip${i}][clipA${i}]`);
  });
  parts.push(`${concatInputs.join('')}concat=n=${items.length * 2}:v=1:a=1[outv][outa]`);
  args.push(
    '-filter_complex',
    parts.join(';'),
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    '-c:v',
    'libx264',
    '-preset',
    opts.preset ?? 'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    out,
  );
  return args;
}
