/**
 * Vertical 1080×1920 layouts (PRD 4.6 step 3). The input is first normalized
 * to 1920×1080 (any resolution change mid-stream is absorbed here), then:
 *  - stack:         facecam crop on top (~38%), gameplay crop below
 *  - gameplay_only: gameplay crop to full height
 *  - facecam_pip:   gameplay full height + facecam in a corner
 * Presets that need a facecam fall back to gameplay_only when none is set.
 */
import type { FacecamRect, LayoutPreset } from '@inbetween/shared';

export const OUT_W = 1080;
export const OUT_H = 1920;
export const SRC_W = 1920;
export const SRC_H = 1080;
export const STACK_FACE_H = 730; // ≈38% of 1920
export const STACK_GAME_H = OUT_H - STACK_FACE_H;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const evenPos = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function facecamPixels(rect: FacecamRect) {
  const w = even((rect.w / 100) * SRC_W);
  const h = even((rect.h / 100) * SRC_H);
  const x = evenPos(clamp((rect.x / 100) * SRC_W, 0, SRC_W - w));
  const y = evenPos(clamp((rect.y / 100) * SRC_H, 0, SRC_H - h));
  return { x, y, w, h };
}

/** Gameplay crop of a given output aspect from the 1920×1080 frame, centered on focusX. */
export function gameplayCrop(outW: number, outH: number, focusX = 0.5) {
  const h = SRC_H;
  const w = even(Math.min(SRC_W, (SRC_H * outW) / outH));
  const x = evenPos(clamp(focusX * SRC_W - w / 2, 0, SRC_W - w));
  return { x, y: 0, w, h };
}

export interface LayoutOptions {
  preset: LayoutPreset;
  facecam: FacecamRect | null;
  focusX?: number;
  fps?: number;
}

export interface LayoutGraph {
  /** filter_complex graph; final video pad is [v]. */
  graph: string;
  effectivePreset: LayoutPreset;
  /** Suggested caption center Y for this layout. */
  captionY: number;
}

export function buildLayoutGraph(o: LayoutOptions): LayoutGraph {
  const fps = o.fps ?? 30;
  const norm = `[0:v]scale=${SRC_W}:${SRC_H}:force_original_aspect_ratio=decrease,pad=${SRC_W}:${SRC_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[base]`;
  let preset = o.preset;
  if (preset !== 'gameplay_only' && !o.facecam) preset = 'gameplay_only';

  if (preset === 'gameplay_only') {
    const g = gameplayCrop(OUT_W, OUT_H, o.focusX);
    return {
      graph: `${norm};[base]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[v]`,
      effectivePreset: preset,
      captionY: 1300,
    };
  }

  const f = facecamPixels(o.facecam!);
  if (preset === 'stack') {
    const g = gameplayCrop(OUT_W, STACK_GAME_H, o.focusX);
    return {
      graph: [
        norm,
        `[base]split=2[fsrc][gsrc]`,
        `[fsrc]crop=${f.w}:${f.h}:${f.x}:${f.y},scale=${OUT_W}:${STACK_FACE_H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${OUT_W}:${STACK_FACE_H},setsar=1[face]`,
        `[gsrc]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${OUT_W}:${STACK_GAME_H}:flags=lanczos,setsar=1[game]`,
        `[face][game]vstack=inputs=2[v]`,
      ].join(';'),
      effectivePreset: preset,
      captionY: STACK_FACE_H + 110,
    };
  }

  // facecam_pip
  const g = gameplayCrop(OUT_W, OUT_H, o.focusX);
  const pipW = 420;
  return {
    graph: [
      norm,
      `[base]split=2[fsrc][gsrc]`,
      `[gsrc]crop=${g.w}:${g.h}:${g.x}:${g.y},scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1[game]`,
      `[fsrc]crop=${f.w}:${f.h}:${f.x}:${f.y},scale=${pipW}:-2:flags=lanczos,setsar=1[face]`,
      `[game][face]overlay=W-w-40:330[v]`,
    ].join(';'),
    effectivePreset: preset,
    captionY: 1300,
  };
}
