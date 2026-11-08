import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assEscape, assTime, buildAss, groupLines, stripEmoji } from './ass';
import { audioExtractArgs, compilationArgs, concatListFile, sourceClipArgs, thumbnailArgs, verticalRenderArgs } from './commands';
import { probeMedia, runProcess } from './ffmpeg';
import { buildLayoutGraph, facecamPixels, gameplayCrop } from './layout';

describe('ASS captions', () => {
  it('formats times and escapes override characters', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(61.237)).toBe('0:01:01.24');
    expect(assEscape('a{b}\\c')).toBe('ab／c');
    expect(stripEmoji('Bhai ne kya kar diya 💀🔥')).toBe('Bhai ne kya kar diya');
  });

  it('groups 2–4 words per line, splitting on pauses', () => {
    const w = (t: string, s: number) => ({ w: t, start: s, end: s + 0.3 });
    const lines = groupLines([w('no', 0), w('way', 0.3), w('bro', 0.6), w('what', 0.9), w('just', 1.2), w('happened', 2.5)]);
    expect(lines.map((l) => l.map((x) => x.w).join(' '))).toEqual(['no way bro what', 'just happened']);
  });

  it('emits one dialogue per word with the active word highlighted plus a 2s title', () => {
    const ass = buildAss({
      words: [
        { w: 'arre', start: 0.2, end: 0.5 },
        { w: 'bhai', start: 0.5, end: 0.9 },
        { w: 'kya', start: 1.0, end: 1.3 },
      ],
      language: 'hinglish',
      title: 'Bhai ne kya kar diya 💀',
      durationS: 10,
    });
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(dialogues).toHaveLength(4);
    expect(dialogues[0]).toContain('{\\c&H0000E5FF&'.slice(0, 6));
    expect(dialogues[0]).toMatch(/ARRE\{.*\} BHAI KYA/);
    expect(dialogues.at(-1)).toMatch(/Title,.*Bhai ne kya kar diya$/);
    expect(dialogues.at(-1)).toContain('0:00:00.00,0:00:02.00');
  });

  it('switches to the Devanagari font and keeps case for Hindi', () => {
    const ass = buildAss({ words: [{ w: 'भाई', start: 0, end: 0.5 }, { w: 'क्या', start: 0.5, end: 1 }], language: 'hi', durationS: 5 });
    expect(ass).toContain('Style: Caption,Noto Sans Devanagari');
    expect(ass).toContain('भाई');
  });
});

describe('layouts', () => {
  it('computes even, in-bounds crops', () => {
    expect(gameplayCrop(1080, 1920, 0.5)).toEqual({ x: 656, y: 0, w: 608, h: 1080 });
    expect(gameplayCrop(1080, 1920, 1).x).toBe(1312);
    expect(facecamPixels({ x: 75, y: 0, w: 25, h: 30 })).toEqual({ x: 1440, y: 0, w: 480, h: 324 });
  });
  it('falls back to gameplay_only without a facecam rect', () => {
    expect(buildLayoutGraph({ preset: 'stack', facecam: null }).effectivePreset).toBe('gameplay_only');
    expect(buildLayoutGraph({ preset: 'stack', facecam: { x: 0, y: 0, w: 30, h: 30 } }).graph).toContain('vstack=inputs=2');
    expect(buildLayoutGraph({ preset: 'facecam_pip', facecam: { x: 0, y: 0, w: 30, h: 30 } }).graph).toContain('overlay=');
  });
});

// ---------------- integration: real ffmpeg on a synthetic stream ----------------

describe('ffmpeg integration', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ib-render-'));
    // 12s 1280x720@30 test pattern with a tone, keyframe every 2s (like YouTube HLS).
    await runProcess('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-shortest',
      '-f', 'segment', '-segment_time', '2', '-segment_format', 'mpegts', '-reset_timestamps', '0',
      path.join(dir, 'seg_%03d.ts'),
    ]);
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('concats segments, renders a 1080x1920 stack layout with captions, extracts audio and a thumbnail', async () => {
    const segs = (await fs.readdir(dir)).filter((f) => f.startsWith('seg_')).sort().map((f) => path.join(dir, f));
    expect(segs.length).toBeGreaterThanOrEqual(5);
    const list = path.join(dir, 'list.txt');
    await fs.writeFile(list, concatListFile(segs));
    const source = path.join(dir, 'source.ts');
    await runProcess('ffmpeg', sourceClipArgs(list, source));
    const src = await probeMedia('ffprobe', source);
    expect(src.durationS).toBeGreaterThan(11);

    const assPath = path.join(dir, 'c.ass');
    await fs.writeFile(
      assPath,
      buildAss({
        words: [
          { w: 'भाई', start: 0.2, end: 0.6 },
          { w: 'क्या', start: 0.6, end: 1.0 },
          { w: 'no', start: 1.2, end: 1.4 },
          { w: 'way', start: 1.4, end: 1.8 },
        ],
        language: 'hi',
        title: 'भाई ने क्या कर दिया 💀',
        durationS: 6,
        captionY: 840,
      }),
    );
    const out = path.join(dir, 'out.mp4');
    const { args, effectivePreset } = verticalRenderArgs({
      input: source,
      output: out,
      offsetS: 3,
      durationS: 6,
      preset: 'stack',
      facecam: { x: 70, y: 0, w: 30, h: 30 },
      assPath,
      fontsDir: null,
    });
    expect(effectivePreset).toBe('stack');
    const r = await runProcess('ffmpeg', args, { timeoutMs: 120_000 });
    const info = await probeMedia('ffprobe', out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(info.durationS).toBeGreaterThan(5.8);
    expect(info.durationS).toBeLessThan(6.3);
    expect(Math.round(info.fps ?? 0)).toBe(30);
    expect(r.ms).toBeLessThan(60_000);

    const wav = path.join(dir, 'a.wav');
    await runProcess('ffmpeg', audioExtractArgs(source, 3, 6, wav));
    const a = await probeMedia('ffprobe', wav);
    expect(a.durationS).toBeCloseTo(6, 0);

    const thumb = path.join(dir, 't.jpg');
    await runProcess('ffmpeg', thumbnailArgs(out, 1, thumb));
    expect((await fs.stat(thumb)).size).toBeGreaterThan(1000);
  });

  it('builds a 16:9 compilation with chapter cards', async () => {
    const segs = (await fs.readdir(dir)).filter((f) => f.startsWith('seg_')).sort().map((f) => path.join(dir, f));
    const t1 = path.join(dir, 't1.txt');
    const t2 = path.join(dir, 't2.txt');
    await fs.writeFile(t1, 'Chapter 1: No way');
    await fs.writeFile(t2, "Chapter 2: Chat's reaction");
    const out = path.join(dir, 'comp.mp4');
    await runProcess(
      'ffmpeg',
      compilationArgs(
        [
          { source: segs[0], offsetS: 0, durationS: 2, titleFile: t1 },
          { source: segs[1], offsetS: 0, durationS: 2, titleFile: t2 },
        ],
        out,
        { preset: 'ultrafast' },
      ),
      { timeoutMs: 120_000 },
    );
    const info = await probeMedia('ffprobe', out);
    expect(info.width).toBe(1920);
    expect(info.durationS).toBeGreaterThan(7.5);
  });
});
