import type { CaptionLanguage, CostReporter } from '@inbetween/shared';

/** One recognized word, times in seconds relative to the start of the audio. */
export interface AsrWord {
  w: string;
  start: number;
  end: number;
}

export interface AsrResult {
  provider: string;
  text: string;
  words: AsrWord[];
  language: string | null;
  durationS: number;
}

export interface AsrOptions {
  language: CaptionLanguage;
  /** `live` = short windows for voice_hype; `captions` = full clip. */
  purpose: 'live' | 'captions';
  prompt?: string;
  signal?: AbortSignal;
  cost?: CostReporter;
}

export interface AsrProvider {
  readonly name: string;
  transcribe(wav: Buffer, opts: AsrOptions): Promise<AsrResult>;
}

export function wavDurationS(wav: Buffer): number {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const byteRate = wav.readUInt32LE(28);
  // Find the data chunk (usually at 36).
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'data') return byteRate ? Math.min(size, wav.length - off - 8) / byteRate : 0;
    off += 8 + size;
  }
  return 0;
}

/** ISO-639-1 code for providers that take a plain language hint. */
export function asrLanguageCode(lang: CaptionLanguage): string {
  switch (lang) {
    case 'hi':
    case 'hinglish':
      return 'hi';
    case 'pt-BR':
      return 'pt';
    default:
      return lang;
  }
}

/** Spreads a phrase's time span over its words proportionally to length. */
export function interpolateWords(text: string, start: number, end: number): AsrWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((a, w) => a + w.length, 0) || 1;
  const span = Math.max(0, end - start);
  let t = start;
  return words.map((w) => {
    const d = (w.length / total) * span;
    const out = { w, start: round3(t), end: round3(t + d) };
    t += d;
    return out;
  });
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export class AsrError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider} ASR failed (${status}): ${message}`);
    this.name = 'AsrError';
  }
}
