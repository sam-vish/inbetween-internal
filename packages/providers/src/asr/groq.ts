/**
 * Groq Whisper (OpenAI-compatible transcription endpoint).
 * Word timestamps need response_format=verbose_json + timestamp_granularities[]=word
 * (console.groq.com/docs/speech-to-text, checked 2026-11-08). Billed with a 10s minimum.
 */
import type { Pricing } from '@inbetween/shared';
import { AsrError, type AsrOptions, type AsrProvider, type AsrResult, asrLanguageCode, wavDurationS } from './types';

export class GroqAsr implements AsrProvider {
  readonly name = 'groq';
  constructor(
    private apiKey: string,
    private model: string,
    private pricing: Pricing,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async transcribe(wav: Buffer, opts: AsrOptions): Promise<AsrResult> {
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
    form.set('model', this.model);
    form.set('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.set('temperature', '0');
    form.set('language', asrLanguageCode(opts.language));
    if (opts.prompt) form.set('prompt', opts.prompt.slice(0, 800));
    const res = await this.fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: opts.signal ?? AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new AsrError(this.name, res.status, body?.error?.message ?? res.statusText);
    const durationS = Number(body.duration ?? wavDurationS(wav));
    opts.cost?.({
      provider: `groq:${this.model}`,
      units: durationS,
      unitType: 'audio_s',
      estCostUsd: this.pricing.audioCost(`groq:${this.model}`, durationS),
    });
    return {
      provider: this.name,
      text: String(body.text ?? '').trim(),
      words: (body.words ?? []).map((w: any) => ({ w: String(w.word).trim(), start: Number(w.start), end: Number(w.end) })),
      language: body.language ?? null,
      durationS,
    };
  }
}
