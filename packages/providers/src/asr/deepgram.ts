/**
 * Deepgram pre-recorded transcription. Hinglish uses language=multi
 * (code-switching); other languages pass their code.
 */
import type { Pricing } from '@inbetween/shared';
import { AsrError, type AsrOptions, type AsrProvider, type AsrResult, asrLanguageCode, wavDurationS } from './types';

export class DeepgramAsr implements AsrProvider {
  readonly name = 'deepgram';
  constructor(
    private apiKey: string,
    private model: string,
    private pricing: Pricing,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(wav: Buffer, opts: AsrOptions): Promise<AsrResult> {
    const qs = new URLSearchParams({
      model: this.model,
      language: opts.language === 'hinglish' ? 'multi' : asrLanguageCode(opts.language),
      punctuate: 'true',
      smart_format: 'true',
    });
    const res = await this.fetchImpl(`https://api.deepgram.com/v1/listen?${qs}`, {
      method: 'POST',
      headers: { authorization: `Token ${this.apiKey}`, 'content-type': 'audio/wav' },
      body: new Uint8Array(wav),
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new AsrError(this.name, res.status, body?.err_msg ?? body?.message ?? res.statusText);
    const alt = body?.results?.channels?.[0]?.alternatives?.[0] ?? {};
    const durationS = Number(body?.metadata?.duration ?? wavDurationS(wav));
    opts.cost?.({
      provider: `deepgram:${this.model}`,
      units: durationS,
      unitType: 'audio_s',
      estCostUsd: this.pricing.audioCost(`deepgram:${this.model}`, durationS),
    });
    return {
      provider: this.name,
      text: String(alt.transcript ?? ''),
      words: (alt.words ?? []).map((w: any) => ({
        w: String(w.punctuated_word ?? w.word),
        start: Number(w.start),
        end: Number(w.end),
      })),
      language: body?.results?.channels?.[0]?.detected_language ?? asrLanguageCode(opts.language),
      durationS,
    };
  }
}
