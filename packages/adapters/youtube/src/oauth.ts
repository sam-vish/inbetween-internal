/**
 * Google OAuth for client consent (read-only YouTube scope). The client
 * clicks one link once; the refresh token + consent timestamp are stored
 * encrypted and double as the written consent record (PRD 2, 6).
 */
export const YT_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildConsentUrl(app: OAuthAppConfig, state: string): string {
  const qs = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: app.redirectUri,
    response_type: 'code',
    scope: YT_READONLY_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${qs}`;
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

export async function exchangeCode(app: OAuthAppConfig, code: string, fetchImpl: typeof fetch = fetch): Promise<TokenResponse> {
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: app.clientId,
      client_secret: app.clientSecret,
      redirect_uri: app.redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) throw new Error(`oauth code exchange failed: ${body.error} ${body.error_description ?? ''}`);
  return body;
}

/** Caches access tokens per refresh token until shortly before expiry. */
export class AccessTokenCache {
  private cache = new Map<string, { token: string; exp: number }>();
  constructor(
    private app: Pick<OAuthAppConfig, 'clientId' | 'clientSecret'> | null,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled() {
    return !!this.app;
  }

  async get(refreshToken: string): Promise<string> {
    if (!this.app) throw new Error('GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not configured');
    const hit = this.cache.get(refreshToken);
    if (hit && hit.exp > Date.now() + 60_000) return hit.token;
    const res = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.app.clientId,
        client_secret: this.app.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const body = (await res.json()) as TokenResponse & { error?: string };
    if (!res.ok) throw new Error(`oauth refresh failed: ${body.error ?? res.status}`);
    this.cache.set(refreshToken, { token: body.access_token, exp: Date.now() + body.expires_in * 1000 });
    return body.access_token;
  }
}
