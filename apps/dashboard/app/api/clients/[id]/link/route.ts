import { signPayload } from '@inbetween/shared/crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { operatorOrNull } from '@/lib/auth';

/** Creates a signed, expiring consent link to send to the client (valid 7 days). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await operatorOrNull();
  if (!auth) return NextResponse.json({ error: 'not an operator' }, { status: 403 });
  const secret = process.env.OAUTH_LINK_SECRET;
  if (!secret) return NextResponse.json({ error: 'OAUTH_LINK_SECRET is not set' }, { status: 500 });
  const base = process.env.APP_URL ?? request.nextUrl.origin;
  const token = signPayload({ c: id, exp: Date.now() + 7 * 24 * 3600_000 }, secret);
  return NextResponse.json({ url: `${base.replace(/\/$/, '')}/api/oauth/youtube/start?t=${encodeURIComponent(token)}` });
}
