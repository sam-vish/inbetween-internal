import { type AsrOptions, type AsrProvider, type AsrResult, wavDurationS } from './types';

/**
 * Offline ASR for tests/replay: emits a fixed phrase spread over the audio
 * (or a scripted transcript), so captions and voice_hype can be exercised
 * without network.
 */
export class MockAsr implements AsrProvider {
  readonly name = 'mock';
  constructor(private script?: (durationS: number, opts: AsrOptions) => string) {}

  async transcribe(wav: Buffer, opts: AsrOptions): Promise<AsrResult> {
    const durationS = wavDurationS(wav);
    const text =
      this.script?.(durationS, opts) ??
      (opts.language === 'hi'
        ? 'अरे भाई क्या कर दिया यह तो पागलपन है'
        : opts.language === 'hinglish'
          ? 'arre bhai kya kar diya ye toh pagalpan hai'
          : 'no way bro what just happened chat that was insane');
    const words = text.split(/\s+/).filter(Boolean);
    const step = words.length ? Math.max(0.25, durationS / (words.length + 1)) : 0;
    return {
      provider: this.name,
      text,
      words: words.map((w, i) => ({ w, start: i * step, end: i * step + step * 0.9 })).filter((w) => w.end <= durationS + 0.01),
      language: opts.language,
      durationS,
    };
  }
}
