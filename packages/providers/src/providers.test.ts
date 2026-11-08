import { Pricing } from '@inbetween/shared';
import { wavFromPcm } from '@inbetween/signals';
import { describe, expect, it } from 'vitest';
import { DeepgramAsr } from './asr/deepgram';
import { GroqAsr } from './asr/groq';
import { MockAsr } from './asr/mock';
import { SarvamAsr } from './asr/sarvam';
import { interpolateWords, wavDurationS } from './asr/types';
import { ClaudeLlm, MockLlm, needsTransliteration } from './llm/index';
import { GeminiVision, loadGameProfile, sanitizeVisionResult } from './vision/index';

const pricing = new Pricing();
const wav = (seconds: number) => wavFromPcm(Buffer.alloc(16000 * 2 * seconds));

type Captured = { url: string; init: RequestInit };
function fakeFetch(respond: (c: Captured) => unknown, status = 200) {
  const calls: Captured[] = [];
  const f = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const c = { url: String(url instanceof Request ? url.url : url), init };
    calls.push(c);
    return new Response(JSON.stringify(respond(c)), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('asr helpers', () => {
  it('reads wav duration and interpolates phrase timings', () => {
    expect(wavDurationS(wav(3))).toBeCloseTo(3);
    const w = interpolateWords('arre bhai', 1, 2);
    expect(w).toEqual([
      { w: 'arre', start: 1, end: 1.5 },
      { w: 'bhai', start: 1.5, end: 2 },
    ]);
  });
});

describe('groq asr', () => {
  it('requests word timestamps and maps the response + cost', async () => {
    const { f, calls } = fakeFetch(() => ({
      text: ' no way bro',
      language: 'english',
      duration: 2,
      words: [
        { word: 'no', start: 0.1, end: 0.3 },
        { word: 'way', start: 0.3, end: 0.6 },
        { word: 'bro', start: 0.7, end: 1.0 },
      ],
    }));
    const costs: number[] = [];
    const r = await new GroqAsr('k', 'whisper-large-v3-turbo', pricing, f).transcribe(wav(2), {
      language: 'en',
      purpose: 'live',
      cost: (u) => costs.push(u.estCostUsd),
    });
    expect(r.words.map((w) => w.w)).toEqual(['no', 'way', 'bro']);
    const form = calls[0].init.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    expect(costs[0]).toBeCloseTo((10 / 3600) * 0.04); // 10s minimum billing
  });
});

describe('deepgram asr', () => {
  it('uses language=multi for hinglish and maps punctuated words', async () => {
    const { f, calls } = fakeFetch(() => ({
      metadata: { duration: 1.5 },
      results: { channels: [{ alternatives: [{ transcript: 'bhai kya', words: [{ word: 'bhai', punctuated_word: 'Bhai', start: 0, end: 0.4 }] }] }] },
    }));
    const r = await new DeepgramAsr('k', 'nova-3', pricing, f).transcribe(wav(1), { language: 'hinglish', purpose: 'captions' });
    expect(new URL(calls[0].url).searchParams.get('language')).toBe('multi');
    expect(r.words[0]).toEqual({ w: 'Bhai', start: 0, end: 0.4 });
  });
});

describe('sarvam asr', () => {
  it('splits long audio, uses translit for hinglish and offsets phrase timestamps', async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() => {
      n++;
      return {
        transcript: n === 1 ? 'arre bhai' : 'kya kar diya',
        language_code: 'hi-IN',
        timestamps: { words: [n === 1 ? 'arre bhai' : 'kya kar diya'], start_time_seconds: [1], end_time_seconds: [2] },
      };
    });
    const r = await new SarvamAsr('k', 'saaras:v4', pricing, f).transcribe(wav(40), { language: 'hinglish', purpose: 'captions' });
    expect(calls).toHaveLength(2);
    expect((calls[0].init.body as FormData).get('mode')).toBe('translit');
    expect(r.text).toBe('arre bhai kya kar diya');
    expect(r.words[2].w).toBe('kya');
    expect(r.words[2].start).toBeCloseTo(26); // second chunk starts at 25s
  });
});

describe('gemini vision', () => {
  it('sends a JSON schema with low media resolution and sanitizes output', async () => {
    const { f, calls } = fakeFetch(() => ({
      candidates: [{ content: { parts: [{ text: '{"event":"crash","confidence":0.83,"detail":"car flips over on the highway near the beach"}' }] } }],
      usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 20 },
    }));
    const costs: number[] = [];
    const r = await new GeminiVision('k', 'gemini-3.5-flash-lite', pricing, f).classify(Buffer.from('jpeg'), {
      profile: loadGameProfile('gta6'),
      cost: (u) => costs.push(u.estCostUsd),
    });
    expect(r).toEqual({ event: 'crash', confidence: 0.83, detail: 'car flips over on the highway near the beach' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_LOW');
    expect(body.systemInstruction.parts[0].text).toMatch(/Grand Theft Auto VI/);
    expect(costs[0]).toBeGreaterThan(0);
  });
  it('clamps and validates model output', () => {
    expect(sanitizeVisionResult({ event: 'dance', confidence: 3 })).toEqual({ event: 'none', confidence: 0, detail: '' });
    expect(sanitizeVisionResult({ event: 'death', confidence: 2, detail: 'x' })).toEqual({ event: 'death', confidence: 1, detail: 'x' });
    expect(loadGameProfile('does-not-exist').id).toBe('generic');
  });
});

describe('claude llm', () => {
  it('requests structured titles with refusal fallback enabled and logs cost', async () => {
    const { f, calls } = fakeFetch(() => ({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ titles: ['Bhai ne kya kar diya 💀', 'Chat went feral', 'Ye kaise hua?!'], label: 'police chase crash' }) }],
      usage: { input_tokens: 400, output_tokens: 60 },
    }));
    const costs: number[] = [];
    const llm = new ClaudeLlm('test-key', 'claude-opus-5-5', pricing, f);
    const out = await llm.titles(
      { language: 'hinglish', transcript: 'arre bhai kya kar diya', visionLabel: 'crash', chatSample: ['LMAO 💀'], game: 'GTA VI', creatorName: 'Rahul' },
      (u) => costs.push(u.estCostUsd),
    );
    expect(out.titles).toHaveLength(3);
    expect(out.label).toBe('police chase crash');
    const req = JSON.parse(String(calls[0].init.body));
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.fallbacks).toBe('default');
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
    const headers = new Headers(calls[0].init.headers as ConstructorParameters<typeof Headers>[0]);
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(costs[0]).toBeCloseTo((400 * 4 + 60 * 20) / 1e6);
  });

  it('only sends words that need transliteration and maps them back by index', async () => {
    const { f, calls } = fakeFetch(() => ({
      id: 'msg_2',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ words: [{ i: 1, t: 'bhai' }, { i: 3, t: 'diya!' }] }) }],
      usage: { input_tokens: 50, output_tokens: 20 },
    }));
    const llm = new ClaudeLlm('k', 'claude-opus-5-5', pricing, f);
    const out = await llm.transliterate(['no', 'भाई', 'way', 'दिया!'], 'latin');
    expect(out).toEqual(['no', 'bhai', 'way', 'diya!']);
    const sent = JSON.parse(String(calls[0].init.body)).messages[0].content as string;
    expect(sent).toContain('भाई');
    expect(sent).not.toContain('"way"');
    // Nothing to do → no API call.
    expect(await llm.transliterate(['all', 'latin'], 'latin')).toEqual(['all', 'latin']);
    expect(calls).toHaveLength(1);
  });

  it('script detection + mocks', async () => {
    expect(needsTransliteration('भाई', 'latin')).toBe(true);
    expect(needsTransliteration('bhai', 'latin')).toBe(false);
    expect(needsTransliteration('بھائی', 'devanagari')).toBe(true);
    expect(await new MockLlm().transliterate(['अरे', 'भाई'], 'latin')).toEqual(['arre', 'bhai']);
    const r = await new MockAsr().transcribe(wav(5), { language: 'en', purpose: 'captions' });
    expect(r.words.length).toBeGreaterThan(3);
    expect(r.words.at(-1)!.end).toBeLessThanOrEqual(5.01);
  });
});
