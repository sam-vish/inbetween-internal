/**
 * Sarvam speech-to-text (Indic-focused). docs.sarvam.ai, checked 2026-11-08:
 *  - POST https://api.sarvam.ai/speech-to-text, header api-subscription-key
 *  - model saaras:v4, mode transcribe | translit | codemix | …
 *  - with_timestamps gives phrase-level (not word-level) timestamps, so
 *    word times are interpolated inside each phrase.
 * `hinglish` uses mode=translit (romanized output), `hi` uses transcribe.
 * Long audio is split into ≤25s requests.
 */
import type { Pricing } from '@inbetween/shared';
import { AsrError, type AsrOptions, type AsrProvider, type AsrResult, type AsrWord, interpolateWords, wavDurationS } from './types';

const MAX_CHUNK_S = 25;

function langCode(lang: AsrOptions['language']): string {
  switch (lang) {
    case 'hi':
    case 'hinglish':
      return 'hi-IN';
    case 'en':
      return 'en-IN';
    default:
      return 'unknown';
  }
}

function splitWav(wav: Buffer, maxS: number): Array<{ wav: Buffer; offsetS: number }> {
  const sampleRate = wav.readUInt32LE(24);
  const bytesPerSec = wav.readUInt32LE(28);
  const data = wav.subarray(44);
  const chunkBytes = Math.floor(maxS * bytesPerSec / 2) * 2;
  if (data.length <= chunkBytes) return [{ wav, offsetS: 0 }];
  const out: Array<{ wav: Buffer; offsetS: number }> = [];
  for (let off = 0; off < data.length; off += chunkBytes) {
    const pcm = data.subarray(off, Math.min(data.length, off + chunkBytes));
    const h = Buffer.from(wav.subarray(0, 44));
    h.writeUInt32LE(36 + pcm.length, 4);
    h.writeUInt32LE(pcm.length, 40);
    out.push({ wav: Buffer.concat([h, pcm]), offsetS: off / bytesPerSec });
  }
  void sampleRate;
  return out;
}

export class SarvamAsr implements AsrProvider {
  readonly name = 'sarvam';
  constructor(
    private apiKey: string,
    private model: string,
    private pricing: Pricing,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async one(wav: Buffer, opts: AsrOptions) {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.set('model', this.model);
    form.set('mode', opts.language === 'hinglish' ? 'translit' : 'transcribe');
    form.set('language_code', langCode(opts.language));
    form.set('with_timestamps', 'true');
    const res = await this.fetchImpl('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': this.apiKey },
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(45_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new AsrError(this.name, res.status, body?.error?.message ?? body?.message ?? res.statusText);
    return body;
  }

  async transcribe(wav: Buffer, opts: AsrOptions): Promise<AsrResult> {
    const durationS = wavDurationS(wav);
    const parts = splitWav(wav, MAX_CHUNK_S);
    const bodies = await Promise.all(parts.map((p) => this.one(p.wav, opts)));
    const words: AsrWord[] = [];
    const texts: string[] = [];
    let language: string | null = null;
    bodies.forEach((body, i) => {
      const off = parts[i].offsetS;
      texts.push(String(body.transcript ?? ''));
      language ??= body.language_code ?? null;
      const ts = body.timestamps;
      if (ts?.words?.length) {
        ts.words.forEach((phrase: string, k: number) => {
          const s = Number(ts.start_time_seconds?.[k] ?? 0) + off;
          const e = Number(ts.end_time_seconds?.[k] ?? s) + off;
          words.push(...interpolateWords(String(phrase), s, e));
        });
      } else if (body.transcript) {
        const partDur = i === parts.length - 1 ? durationS - off : MAX_CHUNK_S;
        words.push(...interpolateWords(String(body.transcript), off, off + partDur));
      }
    });
    opts.cost?.({
      provider: `sarvam:${this.model}`,
      units: durationS,
      unitType: 'audio_s',
      estCostUsd: this.pricing.audioCost(`sarvam:${this.model}`, durationS),
    });
    return { provider: this.name, text: texts.join(' ').trim(), words, language, durationS };
  }
}
