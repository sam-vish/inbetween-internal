/**
 * Claude for hook titles, moment labels and Hinglish/Devanagari
 * transliteration (PRD 4.6). Uses structured outputs (zod schema) through
 * the beta Messages API so the server-side refusal fallback can be enabled.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { CaptionLanguage, CostReporter, Pricing } from '@inbetween/shared';
import { z } from 'zod';

export interface TitleRequest {
  language: CaptionLanguage;
  transcript: string;
  visionLabel: string | null;
  chatSample: string[];
  game: string | null;
  creatorName: string;
}

export interface TitleResult {
  titles: string[];
  label: string;
}

export type TargetScript = 'latin' | 'devanagari';

export interface PremiumBriefRequest {
  language: CaptionLanguage;
  creatorName: string;
  game: string | null;
  transcript: string;
  visionLabel: string | null;
  label: string | null;
  chatSample: string[];
  titles: string[];
  durationS: number;
}

export const PremiumBriefSchema = z.object({
  hook: z.string().describe('On-screen hook for the first 2 seconds, in the creator language'),
  chapter_title: z.string().describe('Short chapter title for compilations'),
  beats: z
    .array(
      z.object({
        t: z.number().describe('Seconds from the start of the clip'),
        duration_s: z.number(),
        kind: z.enum(['punch_in', 'callout', 'caption_emphasis', 'freeze_frame', 'text_card', 'sfx']),
        text: z.string().describe('Callout/label text, or what to emphasize'),
      }),
    )
    .describe('Motion-graphics beats in time order'),
  style_notes: z.string().describe('Pacing, energy and visual style guidance for the editor'),
});
export type PremiumBrief = z.infer<typeof PremiumBriefSchema>;

export interface LlmProvider {
  readonly name: string;
  titles(req: TitleRequest, cost?: CostReporter): Promise<TitleResult>;
  /** Returns one output word per input word, same order. */
  transliterate(words: string[], target: TargetScript, cost?: CostReporter): Promise<string[]>;
  /** Script + storyboard for a premium motion-graphics edit (PRD 4.9). */
  premiumBrief(req: PremiumBriefRequest, cost?: CostReporter): Promise<PremiumBrief>;
}

const LANGUAGE_GUIDE: Record<CaptionLanguage, string> = {
  en: 'English.',
  hi: 'Hindi in Devanagari script (English gaming terms may stay in Latin script).',
  hinglish: 'Hinglish: Hindi written in Latin script mixed with English, the way Indian gamers type (e.g. "Bhai ne kya kar diya 💀").',
  'pt-BR': 'Brazilian Portuguese.',
  es: 'Spanish (Latin American).',
};

const TitlesSchema = z.object({
  titles: z.array(z.string()).describe('Exactly 3 hook titles, best first'),
  label: z.string().describe('2-4 word English label for the moment, for the operator dashboard'),
});

const TranslitSchema = z.object({
  words: z.array(z.object({ i: z.number().int(), t: z.string() })),
});

const DEVANAGARI = /[ऀ-ॿ]/;
const ARABIC = /[؀-ۿ]/;

/** True when a word is written in a script other than the target. */
export function needsTransliteration(word: string, target: TargetScript): boolean {
  if (target === 'latin') return DEVANAGARI.test(word) || ARABIC.test(word);
  // Devanagari target: Whisper sometimes emits Hindi in Urdu script. English words stay in Latin.
  return ARABIC.test(word);
}

export class ClaudeLlm implements LlmProvider {
  readonly name = 'claude';
  private client: Anthropic;

  constructor(
    apiKey: string | undefined,
    private model: string,
    private pricing: Pricing,
    fetchImpl?: typeof fetch,
  ) {
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
      maxRetries: 2,
      timeout: 30_000,
    });
  }

  private report(cost: CostReporter | undefined, usage: { input_tokens?: number; output_tokens?: number } | undefined) {
    if (!cost || !usage) return;
    const inTok = usage.input_tokens ?? 0;
    const outTok = usage.output_tokens ?? 0;
    cost({
      provider: `anthropic:${this.model}`,
      units: inTok + outTok,
      unitType: 'tokens',
      estCostUsd: this.pricing.tokenCost(`anthropic:${this.model}`, inTok, outTok),
    });
  }

  private async parse<T>(system: string, user: string, schema: z.ZodType<T>, maxTokens: number, cost?: CostReporter): Promise<T> {
    const msg = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: maxTokens,
      // Server-side refusal fallback ("default" routes by refusal category).
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // Latency-sensitive, simple task: low effort keeps title generation within the fast-lane budget.
      output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: user }],
    });
    this.report(cost, msg.usage);
    if (msg.stop_reason === 'refusal') throw new Error('claude refused the request');
    if (msg.parsed_output == null) throw new Error(`claude returned no parsable output (stop_reason=${msg.stop_reason})`);
    return msg.parsed_output as T;
  }

  async titles(req: TitleRequest, cost?: CostReporter): Promise<TitleResult> {
    const system = [
      'You write hook titles for YouTube Shorts cut from live gaming streams.',
      'Each title is short (max 60 characters), punchy, specific to what happened, and reads naturally as on-screen text for the first 2 seconds of the Short.',
      'No hashtags, no quotes around the title, no clickbait lies: only claim what the transcript, game event or chat supports.',
      `Write every title in ${LANGUAGE_GUIDE[req.language]}`,
    ].join(' ');
    const user = [
      `Creator: ${req.creatorName}`,
      req.game ? `Game: ${req.game}` : null,
      req.visionLabel ? `Detected game event: ${req.visionLabel}` : null,
      `Streamer transcript of the clip:\n${req.transcript.slice(0, 2000) || '(no speech)'}`,
      req.chatSample.length ? `Chat reactions at the moment:\n${req.chatSample.slice(0, 25).join('\n')}` : null,
      'Return exactly 3 titles (best first) and a short English label.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const out = await this.parse(system, user, TitlesSchema, 1024, cost);
    const titles = out.titles.map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean).slice(0, 3);
    while (titles.length < 3) titles.push(titles[0] ?? out.label);
    return { titles, label: out.label.trim() };
  }

  async transliterate(words: string[], target: TargetScript, cost?: CostReporter): Promise<string[]> {
    const todo = words.map((w, i) => ({ i, w })).filter(({ w }) => needsTransliteration(w, target));
    if (!todo.length) return words;
    const system =
      target === 'latin'
        ? 'Transliterate Hindi/Urdu-script words into casual Hinglish Latin spelling as Indian gamers type it (भाई→bhai, क्या→kya, कर→kar, दिया→diya). Keep punctuation attached. Never translate, never merge or split words.'
        : 'Transliterate Hindi words written in Urdu/Arabic script into Devanagari. Keep punctuation attached. Never translate, never merge or split words.';
    const user = `Return one entry per input index.\n${JSON.stringify(todo)}`;
    const out = await this.parse(system, user, TranslitSchema, 4096, cost);
    const result = [...words];
    for (const { i, t } of out.words) if (i >= 0 && i < result.length && t.trim()) result[i] = t.trim();
    return result;
  }

  async premiumBrief(req: PremiumBriefRequest, cost?: CostReporter): Promise<PremiumBrief> {
    const system = [
      'You are the lead editor of a short-form gaming channel. You turn a raw live-stream moment into a storyboard for a motion-graphics edit (punch-ins, animated callouts such as wanted-level stars, freeze frames, text cards).',
      'Keep beats inside the clip duration, in time order, and only reference what the transcript, game event and chat support.',
      `On-screen text must be in ${LANGUAGE_GUIDE[req.language]}`,
    ].join(' ');
    const user = [
      `Creator: ${req.creatorName}${req.game ? ` · Game: ${req.game}` : ''}`,
      `Clip duration: ${req.durationS.toFixed(1)}s`,
      req.label || req.visionLabel ? `What happened: ${[req.label, req.visionLabel].filter(Boolean).join(' / ')}` : null,
      `Transcript:\n${req.transcript.slice(0, 3000) || '(no speech)'}`,
      req.chatSample.length ? `Chat reactions:\n${req.chatSample.slice(0, 25).join('\n')}` : null,
      req.titles.length ? `Fast-lane title options: ${req.titles.join(' | ')}` : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    // Creative planning benefits from more thinking than titles.
    const msg = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: betaZodOutputFormat(PremiumBriefSchema) },
      system,
      messages: [{ role: 'user', content: user }],
    });
    this.report(cost, msg.usage);
    if (msg.stop_reason === 'refusal' || msg.parsed_output == null) throw new Error(`claude premium brief failed (stop_reason=${msg.stop_reason})`);
    const brief = msg.parsed_output as PremiumBrief;
    brief.beats = brief.beats.filter((b) => b.t >= 0 && b.t < req.durationS).sort((a, b) => a.t - b.t);
    return brief;
  }
}

/** Deterministic offline LLM for tests/replay. */
export class MockLlm implements LlmProvider {
  readonly name = 'mock';
  private static MAP: Record<string, string> = { 'अरे': 'arre', 'भाई': 'bhai', 'क्या': 'kya', 'कर': 'kar', 'दिया': 'diya', 'यह': 'yeh', 'तो': 'toh', 'है': 'hai' };
  async titles(req: TitleRequest): Promise<TitleResult> {
    const base = req.visionLabel ? req.visionLabel.replace(/_/g, ' ') : 'insane moment';
    const titles =
      req.language === 'hinglish'
        ? [`Bhai ne kya kar diya 💀`, `${base} — chat pagal ho gaya`, `Ye kaise hua?!`]
        : req.language === 'hi'
          ? ['भाई ने क्या कर दिया 💀', 'चैट पागल हो गया', 'ये कैसे हुआ?!']
          : [`No way that just happened 💀`, `Chat lost it over this ${base}`, `${req.creatorName} can't believe it`];
    return { titles, label: base };
  }
  async transliterate(words: string[], target: TargetScript): Promise<string[]> {
    if (target !== 'latin') return words;
    return words.map((w) => MockLlm.MAP[w.replace(/[.,!?]/g, '')] ?? w);
  }
  async premiumBrief(req: PremiumBriefRequest): Promise<PremiumBrief> {
    const mid = Math.max(1, req.durationS / 2);
    return {
      hook: req.titles[0] ?? 'Wait for it…',
      chapter_title: req.label ?? 'The moment',
      beats: [
        { t: 0, duration_s: 2, kind: 'text_card', text: req.titles[0] ?? 'Wait for it…' },
        { t: mid, duration_s: 1.5, kind: 'punch_in', text: 'the moment' },
        { t: Math.min(req.durationS - 1, mid + 2), duration_s: 2, kind: 'callout', text: req.visionLabel ?? 'chat reacts' },
      ],
      style_notes: 'High energy, quick punch-ins on the peak, keep captions readable.',
    };
  }
}
