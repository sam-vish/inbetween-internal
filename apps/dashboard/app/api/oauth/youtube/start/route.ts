import { buildConsentUrl } from '@inbetween/adapters/oauth';
import { signPayload, verifyPayload } from '@inbetween/shared/crypto';
import { NextResponse, type NextRequest } from 'next/server';

/** Public: the client clicks their consent link and is sent to Google (read-only YouTube scope). */
export async function GET(request: NextRequest) {
  const secret = process.env.OAUTH_LINK_SECRET;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI } = process.env;
  if (!secret || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_OAUTH_REDIRECT_URI) {
    return new NextResponse('OAuth is not configured', { status: 500 });
  }
  const link = verifyPayload<{ c: string }>(request.nextUrl.searchParams.get('t') ?? '', secret);
  if (!link?.c) return new NextResponse('This link is invalid or has expired. Ask your Inbetween contact for a new one.', { status: 400 });
  const state = signPayload({ c: link.c, n: crypto.randomUUID(), exp: Date.now() + 30 * 60_000 }, secret);
  return NextResponse.redirect(
    buildConsentUrl({ clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, redirectUri: GOOGLE_OAUTH_REDIRECT_URI }, state),
  );
}
