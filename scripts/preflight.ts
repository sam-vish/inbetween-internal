/**
 * Preflight: checks every binary, key and service the worker needs, using
 * free (or 1-unit) calls, and says what to fix.
 *
 *   pnpm preflight              # all checks (spends 1 YouTube quota unit to verify the API key)
 *   pnpm preflight --no-quota   # skip the YouTube API call
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { probeLivePage, YouTubeDataApi } from '@inbetween/adapter-youtube';
import { createRedis, createStorage, loadDotEnv, loadEnv, QuotaLedger, SupabaseDb } from '@inbetween/shared';

const run = promisify(execFile);
type Status = 'ok' | 'warn' | 'fail' | 'skip';
const results: Array<{ area: string; status: Status; detail: string; fix?: string }> = [];
const add = (area: string, status: Status, detail: string, fix?: string) => results.push({ area, status, detail, fix });

async function check(area: string, fn: () => Promise<[Status, string, string?]>) {
  try {
    const [s, d, f] = await fn();
    add(area, s, d, f);
  } catch (err) {
    add(area, 'fail', (err as Error).message.slice(0, 200));
  }
}

async function bin(name: string, args: string[], fix: string) {
  await check(`binary: ${name}`, async () => {
    const { stdout, stderr } = await run(name, args, { timeout: 15_000 });
    return ['ok', (stdout || stderr).split('\n')[0].slice(0, 80), fix];
  }).catch(() => undefined);
  const last = results.at(-1)!;
  if (last.status === 'fail') last.fix = fix;
}

const envFile = loadDotEnv();
const env = loadEnv(process.env, { fresh: true });
const noQuota = process.argv.includes('--no-quota');
add('.env', envFile ? 'ok' : 'warn', envFile ?? 'no .env found', envFile ? undefined : 'cp .env.example .env and fill it in');

// ---- binaries ----
await bin(env.FFMPEG_BIN, ['-version'], 'apt-get install ffmpeg');
await bin(env.FFPROBE_BIN, ['-version'], 'apt-get install ffmpeg');
await bin(env.STREAMLINK_BIN, ['--version'], 'pip install streamlink');
await bin(env.YTDLP_BIN, ['--version'], 'pip install yt-dlp');
await check('fonts (captions)', async () => {
  const { stdout } = await run('fc-list', [':', 'family'], { timeout: 10_000 });
  const latin = /Noto Sans(,|$)/m.test(stdout);
  const deva = /Noto Sans Devanagari/.test(stdout);
  return latin && deva ? ['ok', 'Noto Sans + Noto Sans Devanagari'] : ['fail', `latin=${latin} devanagari=${deva}`, 'apt-get install fonts-noto-core'];
});

// ---- Supabase ----
await check('supabase', async () => {
  if (!env.SUPABASE_URL) return ['fail', 'SUPABASE_URL missing', 'set SUPABASE_URL'];
  if (!env.SUPABASE_SERVICE_KEY) return ['fail', 'SUPABASE_SERVICE_KEY missing', 'Supabase → Project Settings → API Keys → Secret keys → copy into SUPABASE_SERVICE_KEY'];
  const db = new SupabaseDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const clients = await db.listActiveClients();
  const used = await db.sumQuotaSince(Date.now() - 86_400_000);
  const { data: ops } = await db.sb.from('operators').select('email');
  return ['ok', `${clients.length} active clients, ${ops?.length ?? 0} operators, ${used} quota units in last 24h`];
});

// ---- Redis ----
await check('redis', async () => {
  if (!env.REDIS_URL) return ['warn', 'not set: single-process in-memory queues', 'run Redis (docker compose) and set REDIS_URL'];
  const r = createRedis(env.REDIS_URL)!;
  let lastErr = '';
  r.on('error', (e) => (lastErr = e.message));
  try {
    const pong = await Promise.race([r.ping(), new Promise<string>((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    return ['ok', `PING → ${pong}`];
  } catch {
    return ['fail', `cannot reach ${env.REDIS_URL} ${lastErr}`.trim(), 'docker compose -f infra/docker-compose.yml up -d redis (or unset REDIS_URL for single-process dev)'];
  } finally {
    r.disconnect();
  }
});

// ---- storage ----
await check('storage', async () => {
  const s = createStorage(env);
  if (s.kind === 'local') return ['warn', 'local disk (dev only)', 'create an R2 bucket + API token and set R2_*'];
  await s.putBuffer('doctor/ping.txt', Buffer.from('ok'), 'text/plain');
  const exists = await s.exists('doctor/ping.txt');
  await s.delete('doctor/ping.txt');
  return exists ? ['ok', `R2 bucket ${env.R2_BUCKET} read/write`] : ['fail', 'wrote but could not read back'];
});

// ---- YouTube ----
await check('youtube page probe (no quota)', async () => {
  const r = await probeLivePage('UC_x5XG1OV2P6uZZ5FSM9Ttw', { cookiesFile: env.YOUTUBE_COOKIES_FILE });
  return r.via === 'page' ? ['ok', 'youtube.com reachable'] : ['fail', r.error ?? 'unreachable'];
});
await check('youtube data api', async () => {
  if (!env.YOUTUBE_API_KEY) return ['fail', 'YOUTUBE_API_KEY missing', 'Google Cloud → enable YouTube Data API v3 → create API key'];
  if (noQuota) return ['skip', 'key present (not verified: --no-quota)'];
  const db = env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? new SupabaseDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY) : null;
  const { MemoryDb } = await import('@inbetween/shared');
  const quota = new QuotaLedger({ db: db ?? new MemoryDb(), dailyLimit: env.YOUTUBE_DAILY_QUOTA });
  try {
    const items = await new YouTubeDataApi({ quota, apiKey: env.YOUTUBE_API_KEY }).videosList(['jNQXAC9IVRw']);
    return items.length ? ['ok', 'videos.list works (1 unit)'] : ['warn', 'videos.list returned nothing'];
  } finally {
    await quota.close();
  }
});
await check('streamlink vs bot wall', async () => {
  if (env.YOUTUBE_COOKIES_FILE) return ['ok', `cookies file set (${env.YOUTUBE_COOKIES_FILE})`];
  return ['warn', 'no cookies file', 'if streamlink fails with "Sign in to confirm you\'re not a bot", export cookies (Netscape) from a dedicated account and set YOUTUBE_COOKIES_FILE'];
});
await check('google oauth (client consent)', async () => {
  const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_REDIRECT_URI', 'OAUTH_ENCRYPTION_KEY', 'OAUTH_LINK_SECRET'].filter((k) => !(env as any)[k]);
  return missing.length
    ? ['fail', `missing ${missing.join(', ')}`, 'Google Cloud → OAuth consent screen + Web client; redirect URI = <dashboard>/api/oauth/youtube/callback']
    : ['ok', `redirect ${env.GOOGLE_OAUTH_REDIRECT_URI}`];
});

// ---- providers ----
await check('asr', async () => {
  if (env.GROQ_API_KEY) {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${env.GROQ_API_KEY}` } });
    return r.ok ? ['ok', 'Groq key valid'] : ['fail', `Groq ${r.status}`, 'check GROQ_API_KEY'];
  }
  if (env.DEEPGRAM_API_KEY) {
    const r = await fetch('https://api.deepgram.com/v1/projects', { headers: { authorization: `Token ${env.DEEPGRAM_API_KEY}` } });
    return r.ok ? ['ok', 'Deepgram key valid'] : ['fail', `Deepgram ${r.status}`, 'check DEEPGRAM_API_KEY'];
  }
  if (env.SARVAM_API_KEY) return ['ok', 'Sarvam key present (not verified)'];
  return ['fail', 'no ASR key: captions + voice signal use the mock', 'set GROQ_API_KEY (or DEEPGRAM_API_KEY / SARVAM_API_KEY)'];
});
await check('vision (gemini)', async () => {
  if (!env.GEMINI_API_KEY) return ['warn', 'no key: vision signal disabled (mock)', 'set GEMINI_API_KEY'];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_VISION_MODEL}`, { headers: { 'x-goog-api-key': env.GEMINI_API_KEY } });
  return r.ok ? ['ok', `${env.GEMINI_VISION_MODEL} available`] : ['fail', `Gemini ${r.status}`, 'check GEMINI_API_KEY / GEMINI_VISION_MODEL'];
});
await check('titles (claude)', async () => {
  if (!env.ANTHROPIC_API_KEY) return ['fail', 'no key: titles use the mock', 'set ANTHROPIC_API_KEY'];
  const m = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).models.retrieve(env.CLAUDE_MODEL);
  return ['ok', `${m.id} available`];
});

// ---- delivery + alerts ----
await check('telegram', async () => {
  if (!env.TELEGRAM_BOT_TOKEN) return ['warn', 'no bot token: Telegram delivery unavailable', '@BotFather → /newbot → TELEGRAM_BOT_TOKEN'];
  const r = (await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`)).json()) as any;
  return r.ok ? ['ok', `bot @${r.result.username}`] : ['fail', 'invalid token'];
});
await check('drive', async () => (env.GOOGLE_SERVICE_ACCOUNT_JSON ? ['ok', 'service account set'] : ['warn', 'not set: Drive delivery unavailable', 'create a service account key; share client folders with its email']));
await check('ops alerts', async () => (env.OPS_DISCORD_WEBHOOK_URL || env.OPS_TELEGRAM_CHAT_ID ? ['ok', 'configured'] : ['warn', 'no ops channel: quota/cost alerts only in logs', 'set OPS_DISCORD_WEBHOOK_URL or OPS_TELEGRAM_CHAT_ID']));

// ---- report ----
const icon: Record<Status, string> = { ok: '✅', warn: '⚠️ ', fail: '❌', skip: '⏭️ ' };
for (const r of results) {
  console.log(`${icon[r.status]} ${r.area.padEnd(32)} ${r.detail}`);
  if (r.fix && r.status !== 'ok') console.log(`   ↳ ${r.fix}`);
}
const fails = results.filter((r) => r.status === 'fail').length;
console.log(`\n${fails ? `${fails} blocking issue(s).` : 'Ready for M1: onboard a consenting creator and go live.'}`);
process.exit(fails ? 1 : 0);
