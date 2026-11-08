/**
 * ASS subtitle generation (PRD 4.6 step 4): 2–4 words per line with the
 * active word highlighted, client style + language, and the hook title
 * burned in for the first 2 seconds.
 *
 * Emoji are stripped from burned-in text: libass cannot render color emoji
 * fonts. Stored titles keep them.
 */
import type { CaptionLanguage } from '@inbetween/shared';

export interface CaptionWord {
  w: string;
  /** Seconds relative to clip start. */
  start: number;
  end: number;
}

export interface CaptionStyle {
  id: string;
  fontLatin: string;
  fontDevanagari: string;
  fontSize: number;
  /** ASS colors are &HAABBGGRR. */
  primary: string;
  active: string;
  outline: string;
  outlineWidth: number;
  shadow: number;
  uppercase: boolean;
  activeScale: number;
  titleFontSize: number;
  titleBox: string;
}

export const CAPTION_STYLES: Record<string, CaptionStyle> = {
  bold_yellow: {
    id: 'bold_yellow',
    fontLatin: 'Noto Sans',
    fontDevanagari: 'Noto Sans Devanagari',
    fontSize: 86,
    primary: '&H00FFFFFF',
    active: '&H0000E5FF',
    outline: '&H00000000',
    outlineWidth: 7,
    shadow: 2,
    uppercase: true,
    activeScale: 112,
    titleFontSize: 66,
    titleBox: '&H40000000',
  },
  clean_white: {
    id: 'clean_white',
    fontLatin: 'Noto Sans',
    fontDevanagari: 'Noto Sans Devanagari',
    fontSize: 74,
    primary: '&H00FFFFFF',
    active: '&H00FFFFFF',
    outline: '&H00101010',
    outlineWidth: 5,
    shadow: 0,
    uppercase: false,
    activeScale: 106,
    titleFontSize: 60,
    titleBox: '&H60000000',
  },
  hype_red: {
    id: 'hype_red',
    fontLatin: 'Noto Sans',
    fontDevanagari: 'Noto Sans Devanagari',
    fontSize: 90,
    primary: '&H00FFFFFF',
    active: '&H003C3CFF',
    outline: '&H00000000',
    outlineWidth: 8,
    shadow: 3,
    uppercase: true,
    activeScale: 118,
    titleFontSize: 68,
    titleBox: '&H30101099',
  },
};

const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}️‍⃣]/gu;

export function stripEmoji(s: string): string {
  return s.replace(EMOJI, '').replace(/\s{2,}/g, ' ').trim();
}

/** Removes characters that ASS would interpret (override blocks, escapes). */
export function assEscape(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\\/g, '／').replace(/\r?\n/g, ' ');
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

const DEVANAGARI = /[ऀ-ॿ]/;

/** Groups words into caption lines: 2–4 words, ≤ maxChars, split on pauses and sentence ends. */
export function groupLines(words: CaptionWord[], opts: { maxWords?: number; maxChars?: number; pauseS?: number } = {}): CaptionWord[][] {
  const maxWords = opts.maxWords ?? 4;
  const maxChars = opts.maxChars ?? 18;
  const pauseS = opts.pauseS ?? 0.6;
  const lines: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  const chars = (ws: CaptionWord[]) => ws.reduce((a, w) => a + w.w.length + 1, -1);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const gap = w.start - prev.end;
      const sentenceEnd = /[.!?।]$/.test(prev.w);
      const tooLong = cur.length >= maxWords || chars([...cur, w]) > maxChars;
      if ((tooLong || gap > pauseS || (sentenceEnd && cur.length >= 2)) && cur.length >= 1) {
        // Avoid single-word orphans when the next word would still fit.
        if (cur.length === 1 && !tooLong && gap <= pauseS * 2 && !sentenceEnd) {
          cur.push(w);
          continue;
        }
        lines.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

export interface AssOptions {
  words: CaptionWord[];
  language: CaptionLanguage;
  style?: string;
  title?: string | null;
  titleDurationS?: number;
  captionY?: number;
  durationS: number;
  width?: number;
  height?: number;
}

export function buildAss(o: AssOptions): string {
  const st = CAPTION_STYLES[o.style ?? 'bold_yellow'] ?? CAPTION_STYLES.bold_yellow;
  const W = o.width ?? 1080;
  const H = o.height ?? 1920;
  const usesDevanagari = o.language === 'hi' || o.words.some((w) => DEVANAGARI.test(w.w));
  const font = usesDevanagari ? st.fontDevanagari : st.fontLatin;
  const upper = st.uppercase && !usesDevanagari;
  const y = o.captionY ?? Math.round(H * 0.68);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${font},${st.fontSize},${st.primary},${st.active},${st.outline},&H80000000,1,0,0,0,100,100,0,0,1,${st.outlineWidth},${st.shadow},5,60,60,0,1`,
    `Style: Title,${usesDevanagari ? st.fontDevanagari : st.fontLatin},${st.titleFontSize},&H00FFFFFF,&H00FFFFFF,${st.titleBox},${st.titleBox},1,0,0,0,100,100,0,0,3,18,0,8,70,70,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  const clean = o.words
    .map((w) => ({ ...w, w: assEscape(stripEmoji(w.w)) }))
    .filter((w) => w.w && w.end > w.start && w.start < o.durationS)
    .map((w) => ({ ...w, w: upper ? w.w.toUpperCase() : w.w, end: Math.min(w.end, o.durationS) }));

  const lines = groupLines(clean);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const nextStart = lines[li + 1]?.[0]?.start ?? o.durationS;
    const lineEnd = Math.min(nextStart, line[line.length - 1].end + 0.35, o.durationS);
    for (let wi = 0; wi < line.length; wi++) {
      const s = wi === 0 ? line[0].start : line[wi].start;
      const e = wi === line.length - 1 ? lineEnd : line[wi + 1].start;
      if (e <= s) continue;
      const text = line
        .map((w, k) =>
          k === wi
            ? `{\\c${st.active}\\fscx${st.activeScale}\\fscy${st.activeScale}}${w.w}{\\c${st.primary}\\fscx100\\fscy100}`
            : w.w,
        )
        .join(' ');
      events.push(`Dialogue: 1,${assTime(s)},${assTime(e)},Caption,,0,0,0,,{\\an5\\pos(${W / 2},${y})}${text}`);
    }
  }

  const title = o.title ? assEscape(stripEmoji(o.title)) : '';
  if (title) {
    const d = Math.min(o.titleDurationS ?? 2, o.durationS);
    events.push(`Dialogue: 2,${assTime(0)},${assTime(d)},Title,,0,0,0,,{\\an8\\pos(${W / 2},170)\\fad(0,200)}${title}`);
  }
  return [...header, ...events, ''].join('\n');
}
