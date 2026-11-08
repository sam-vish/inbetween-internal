/**
 * Environment configuration. All secrets come from `.env` (see `.env.example`).
 * Every integration is optional so the pipeline can run fully offline
 * (memory DB, local storage, mock providers) for replay and tests.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => (typeof v === 'boolean' ? v : v ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : undefined));

const opt = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
  WORKER_HOST_ID: z.string().default(os.hostname()),
  DATA_DIR: z.string().default('./data'),
  WORKER_HTTP_PORT: z.coerce.number().default(8787),
  PUBLIC_WORKER_URL: opt,
  WORKER_ROLE: z.enum(['all', 'ingest', 'render']).default('all'),
  RENDER_CONCURRENCY: z.coerce.number().int().min(1).default(2),

  // YouTube
  YOUTUBE_API_KEY: opt,
  YOUTUBE_DAILY_QUOTA: z.coerce.number().default(10_000),
  YOUTUBE_COOKIES_FILE: opt,
  GO_LIVE_INTERVAL_S: z.coerce.number().default(60),
  STREAMS_TAB_INTERVAL_S: z.coerce.number().default(300),
  HLS_RESOLVER: z.enum(['streamlink', 'ytdlp']).default('streamlink'),
  HLS_QUALITY: z.string().default('720p60,720p,best'),
  CHAT_POLL_MIN_MS: z.coerce.number().default(8000),
  WEBSUB_ENABLED: bool,

  // Google OAuth (client consent, read-only scope)
  GOOGLE_CLIENT_ID: opt,
  GOOGLE_CLIENT_SECRET: opt,
  GOOGLE_OAUTH_REDIRECT_URI: opt,
  OAUTH_ENCRYPTION_KEY: opt,
  OAUTH_LINK_SECRET: opt,
  AUTHOR_HASH_SALT: z.string().default('inbetween-dev-salt'),

  // Data plane
  SUPABASE_URL: opt,
  SUPABASE_SERVICE_KEY: opt,
  REDIS_URL: opt,
  DB_DRIVER: z.enum(['supabase', 'memory']).optional(),

  // Object storage
  STORAGE_DRIVER: z.enum(['r2', 'local']).optional(),
  R2_ACCOUNT_ID: opt,
  R2_ACCESS_KEY_ID: opt,
  R2_SECRET_ACCESS_KEY: opt,
  R2_BUCKET: opt,
  R2_ENDPOINT: opt,
  R2_PUBLIC_BASE_URL: opt,
  LOCAL_STORAGE_PUBLIC_URL: opt,

  // Providers
  ASR_PROVIDER: z.enum(['groq', 'deepgram', 'sarvam', 'mock', 'none']).optional(),
  ASR_LIVE_PROVIDER: z.enum(['groq', 'deepgram', 'sarvam', 'mock', 'none']).optional(),
  GROQ_API_KEY: opt,
  GROQ_ASR_MODEL: z.string().default('whisper-large-v3-turbo'),
  DEEPGRAM_API_KEY: opt,
  DEEPGRAM_MODEL: z.string().default('nova-3'),
  SARVAM_API_KEY: opt,
  SARVAM_MODEL: z.string().default('saaras:v4'),
  VISION_PROVIDER: z.enum(['gemini', 'mock', 'none']).optional(),
  GEMINI_API_KEY: opt,
  GEMINI_VISION_MODEL: z.string().default('gemini-3.5-flash-lite'),
  LLM_PROVIDER: z.enum(['claude', 'mock']).optional(),
  ANTHROPIC_API_KEY: opt,
  CLAUDE_MODEL: z.string().default('claude-opus-5-5'),
  PRICING_OVERRIDES_JSON: opt,

  // Delivery + ops alerts
  TELEGRAM_BOT_TOKEN: opt,
  GOOGLE_SERVICE_ACCOUNT_JSON: opt,
  DISCORD_MAX_UPLOAD_MB: z.coerce.number().default(10),
  TELEGRAM_MAX_UPLOAD_MB: z.coerce.number().default(50),
  OPS_DISCORD_WEBHOOK_URL: opt,
  OPS_TELEGRAM_CHAT_ID: opt,

  // Binaries
  FFMPEG_BIN: z.string().default('ffmpeg'),
  FFPROBE_BIN: z.string().default('ffprobe'),
  STREAMLINK_BIN: z.string().default('streamlink'),
  YTDLP_BIN: z.string().default('yt-dlp'),
  FONTS_DIR: opt,
  X264_PRESET: z.string().default('veryfast'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env, { fresh = false } = {}): Env {
  if (cached && !fresh && source === process.env) return cached;
  // Blank lines like `ASR_PROVIDER=` in .env mean "unset", not "empty string".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.parse(cleaned);
  if (source === process.env) cached = parsed;
  return parsed;
}

export function resetEnvCache(): void {
  cached = null;
}

/**
 * Loads the nearest `.env` walking up from the working directory (pnpm runs
 * app scripts from apps/*). Variables already set in the environment win
 * (Docker env_file, systemd, CI). A relative DATA_DIR is resolved against the
 * directory holding the .env, so every app shares the same data folder.
 */
export function loadDotEnv(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (let i = 0; i < 6; i++) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      const before = { ...process.env };
      process.loadEnvFile(file);
      for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
      const dataDir = process.env.DATA_DIR;
      if (dataDir && !path.isAbsolute(dataDir)) process.env.DATA_DIR = path.resolve(dir, dataDir);
      cached = null;
      return file;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
