import { exchangeCode, YouTubeDataApi } from '@inbetween/adapters/oauth';
import { encryptSecret, verifyPayload } from '@inbetween/shared/crypto';
import { SupabaseDb } from '@inbetween/shared/db';
import { QuotaLedger } from '@inbetween/shared/quota';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Google redirects here after consent. Stores the encrypted refresh token and
 * consent timestamp (the written consent record, PRD §6) after checking the
 * authorized channel is the client's channel. The channels.list call (1 unit)
 * goes through the quota ledger like every other YouTube call.
 */
export async function GET(request: NextRequest) {
  const done = (q: string) => NextResponse.redirect(new URL(`/connect/done?${q}`, request.nextUrl.origin));
  const env = process.env;
  if (!env.OAUTH_LINK_SECRET || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_OAUTH_REDIRECT_URI || !env.OAUTH_ENCRYPTION_KEY) {
    return done('error=config');
  }
  if (request.nextUrl.searchParams.get('error')) return done('error=denied');
  const state = verifyPayload<{ c: string }>(request.nextUrl.searchParams.get('state') ?? '', env.OAUTH_LINK_SECRET);
  const code = request.nextUrl.searchParams.get('code');
  if (!state?.c || !code) return done('error=expired');

  const db = new SupabaseDb(env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
  const client = await db.getClient(state.c);
  if (!client) return done('error=client');

  let tokens;
  try {
    tokens = await exchangeCode({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI }, code);
  } catch {
    return done('error=exchange');
  }
  if (!tokens.refresh_token) return done('error=no_refresh');

  const quota = new QuotaLedger({ db, dailyLimit: Number(env.YOUTUBE_DAILY_QUOTA ?? 10_000) });
  let channel: { id: string; title: string } | null = null;
  try {
    channel = await new YouTubeDataApi({ quota }).myChannel(tokens.access_token);
  } finally {
    await quota.close();
  }
  if (!channel) return done('error=no_channel');
  if (client.youtubeChannelId && client.youtubeChannelId !== channel.id) {
    return done(`error=mismatch&got=${encodeURIComponent(channel.title)}`);
  }
  await db.updateClient(client.id, {
    oauthRefreshTokenEnc: encryptSecret(tokens.refresh_token, env.OAUTH_ENCRYPTION_KEY),
    consentAt: Date.now(),
    youtubeChannelId: channel.id,
  });
  await db.sb.from('clients').update({ oauth_channel_title: channel.title }).eq('id', client.id);
  return done(`ok=1&channel=${encodeURIComponent(channel.title)}`);
}
