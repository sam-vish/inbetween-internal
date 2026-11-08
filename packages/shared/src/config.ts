/**
 * Per-client configuration (PRD 4.1). Stored as `clients.config` jsonb and
 * parsed through this schema everywhere, so missing keys always get defaults.
 *
 * Zod 4 note: nested objects use `.prefault({})` so their inner defaults are
 * applied when the key is absent (`.default({})` would skip inner parsing).
 */
import { z } from 'zod';

export const LAYOUT_PRESETS = ['stack', 'gameplay_only', 'facecam_pip'] as const;
export type LayoutPreset = (typeof LAYOUT_PRESETS)[number];

export const CAPTION_LANGUAGES = ['en', 'hi', 'hinglish', 'pt-BR', 'es'] as const;
export type CaptionLanguage = (typeof CAPTION_LANGUAGES)[number];

export const DEFAULT_REACTION_WEIGHTS: Record<string, number> = {
  '😂': 1,
  '🤣': 1,
  '💀': 1.2,
  '🔥': 0.8,
  '😱': 1.2,
  '😭': 1,
  LOL: 0.8,
  LMAO: 1,
  OP: 0.8,
  GG: 0.6,
  W: 0.5,
  OMG: 0.8,
};

export const DEFAULT_HYPE_PHRASES: Record<string, string[]> = {
  en: ['no way', 'bro', 'what', 'chat', "let's go", 'lets go', 'oh my god', 'oh my gosh', 'holy'],
  hi: ['bhai', 'kya', 'arre', 'oh bhai', 'kya kar diya', 'pagal', 'bhaag', 'भाई', 'क्या', 'अरे', 'ओह भाई', 'क्या कर दिया', 'पागल', 'भाग'],
  hinglish: ['bhai', 'kya', 'arre', 'are', 'oh bhai', 'kya kar diya', 'pagal', 'bhaag', 'bhag'],
  'pt-BR': [],
  es: [],
};

export const DEFAULT_BOT_ACCOUNTS = [
  'Nightbot',
  'StreamElements',
  'Streamlabs',
  'Moobot',
  'Fossabot',
  'Wizebot',
  'Botisimo',
];

const pct = z.number().min(0).max(100);

export const FacecamRectSchema = z.object({ x: pct, y: pct, w: pct, h: pct });
export type FacecamRect = z.infer<typeof FacecamRectSchema>;

export const SignalWeightsSchema = z.object({
  chat_rate: z.number().default(1.0),
  chat_reaction: z.number().default(0.8),
  chat_caps: z.number().default(0.4),
  audio_loud: z.number().default(0.8),
  voice_hype: z.number().default(0.6),
  /** Vision contributes weight × confidence (0..1), not a z-score. */
  vision_event: z.number().default(2.0),
});
export type SignalWeights = z.infer<typeof SignalWeightsSchema>;

export const ThresholdsSchema = z.object({
  /** Smoothed fused score needed to open a moment. */
  score: z.number().default(4.5),
  cooldown_s: z.number().default(45),
  max_clips_per_hour: z.number().int().default(12),
  /** Distinct signal families that must be elevated at the trigger second. */
  families_required: z.number().int().min(1).default(2),
  /** z at which a family counts as elevated. */
  family_z: z.number().default(1.5),
  /** Vision confidence at which the vision family counts as elevated. */
  vision_min_conf: z.number().default(0.6),
});

export const TimingSchema = z.object({
  pre_roll_s: z.number().default(20),
  post_roll_s: z.number().default(15),
  max_clip_s: z.number().default(60),
  /** Fallback offset from chat peak to event when no audio peak exists. */
  chat_lag_s: z.number().default(8),
  /** Look for an audio peak this far before the chat peak. */
  audio_peak_lookback_s: z.number().default(20),
  /** Minimum audio z for the audio peak to be trusted as the event time. */
  audio_peak_min_z: z.number().default(1.0),
  paid_suppression_s: z.number().default(12),
  /** Multiplier applied to suppressed signals inside the paid window. */
  paid_suppression_factor: z.number().min(0).max(1).default(0.25),
  /** Scorer evaluates second t at now - delay, so late signals (ASR) can land. */
  scorer_delay_s: z.number().default(10),
  smoothing_s: z.number().int().min(1).default(3),
  /** Keep extending while smoothed score ≥ extend_ratio × threshold. */
  extend_ratio: z.number().default(0.7),
  /** Close an open moment after this many seconds below the extend level. */
  close_after_s: z.number().default(3),
  /** Manual correction added to video timestamps (seconds). */
  video_offset_s: z.number().default(0),
  /**
   * Lag-aligned fusion: chat reacts 5–15s after the event, so at chat-time t
   * the fast signals (audio, voice, vision) contribute their max over
   * [t - align_window_s, t]. 0 = the plain instantaneous PRD formula.
   */
  align_window_s: z.number().min(0).default(12),
  /** Moments are force-closed after this long open (seconds). */
  max_open_s: z.number().default(60),
});

export const VisionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sparse_interval_s: z.number().default(10),
  burst_interval_s: z.number().default(2),
  burst_duration_s: z.number().default(30),
  /** Burst when the cheap (chat + audio) score crosses ratio × threshold. */
  burst_ratio: z.number().default(0.6),
  /** game_profiles/<id>.json */
  game_profile: z.string().default('generic'),
  /** A vision result stays valid for the scorer this long after the frame. */
  hold_s: z.number().default(6),
});

export const VoiceConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Audio window per live ASR request. */
  window_s: z.number().default(6),
});

export const SpamConfigSchema = z.object({
  per_user_max_per_5s: z.number().int().default(2),
  per_message_token_cap: z.number().int().default(3),
  bot_accounts: z.array(z.string()).default(DEFAULT_BOT_ACCOUNTS),
});

export const BaselineConfigSchema = z.object({
  window_s: z.number().default(600),
  min_samples: z.number().int().default(60),
});

export const ActiveHoursSchema = z.object({
  tz: z.string().default('Asia/Kolkata'),
  /** HH:MM, local to tz. A window may wrap midnight (start > end). */
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

export const ClientConfigSchema = z.object({
  facecam_rect: FacecamRectSchema.nullable().default(null),
  layout_preset: z.enum(LAYOUT_PRESETS).default('gameplay_only'),
  /** 0..1 horizontal focus for gameplay crops (0.5 = center). */
  gameplay_focus_x: z.number().min(0).max(1).default(0.5),
  caption_language: z.enum(CAPTION_LANGUAGES).default('en'),
  caption_style: z.string().default('bold_yellow'),
  reaction_weights: z.record(z.string(), z.number()).default(DEFAULT_REACTION_WEIGHTS),
  /** Member emojis arrive as `:name:` text. Each gets this weight in chat_reaction. */
  member_emojis: z.array(z.string()).default([]),
  member_emoji_weight: z.number().default(1.0),
  hype_phrases: z.record(z.string(), z.array(z.string())).default(DEFAULT_HYPE_PHRASES),
  thresholds: ThresholdsSchema.prefault({}),
  weights: SignalWeightsSchema.prefault({}),
  timing: TimingSchema.prefault({}),
  vision: VisionConfigSchema.prefault({}),
  voice: VoiceConfigSchema.prefault({}),
  spam: SpamConfigSchema.prefault({}),
  baseline: BaselineConfigSchema.prefault({}),
  /** Per-stream hard cost cap; above it vision degrades to sparse-only. */
  cost_cap_usd: z.number().default(3),
  /** How the chat connection authenticates. `oauth` needs the client's refresh token. */
  chat_auth: z.enum(['api_key', 'oauth']).default('api_key'),
  active_hours: ActiveHoursSchema.nullable().default(null),
  premium_top_n: z.number().int().default(5),
  game: z.string().nullable().default(null),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

export const DeliveryTargetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('discord'), target: z.string().url() }),
  z.object({ type: z.literal('telegram'), target: z.string().min(1) }),
  z.object({ type: z.literal('drive'), target: z.string().min(1) }),
  z.object({ type: z.literal('none'), target: z.string().default('') }),
]);
export type DeliveryTarget = z.infer<typeof DeliveryTargetSchema>;

export function parseClientConfig(raw: unknown): ClientConfig {
  return ClientConfigSchema.parse(raw ?? {});
}

export function parseDeliveryTarget(raw: unknown): DeliveryTarget {
  const parsed = DeliveryTargetSchema.safeParse(raw ?? { type: 'none' });
  return parsed.success ? parsed.data : { type: 'none', target: '' };
}

/** True when `now` is inside the client's active window (or no window is set). */
export function isWithinActiveHours(cfg: ClientConfig, now = new Date()): boolean {
  const ah = cfg.active_hours;
  if (!ah) return true;
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: ah.tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const [h, m] = fmt.format(now).split(':').map(Number);
  const cur = h * 60 + m;
  const toMin = (s: string) => {
    const [hh, mm] = s.split(':').map(Number);
    return hh * 60 + mm;
  };
  const start = toMin(ah.start);
  const end = toMin(ah.end);
  if (start === end) return true;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}
