import { NextResponse, type NextRequest } from 'next/server';
import { operatorOrNull } from '@/lib/auth';
import { mediaUrl } from '@/lib/media';

/** Redirects an operator to a (signed) URL for a stored clip/thumbnail/frame. */
export async function GET(request: NextRequest) {
  const auth = await operatorOrNull();
  if (!auth) return new NextResponse('forbidden', { status: 403 });
  const key = request.nextUrl.searchParams.get('key') ?? '';
  if (!/^(clips|sources|compilations|live)\/[A-Za-z0-9/_.-]+$/.test(key)) return new NextResponse('bad key', { status: 400 });
  const url = await mediaUrl(key, 3600);
  if (!url) return new NextResponse('storage not configured', { status: 503 });
  return NextResponse.redirect(url, { status: 302, headers: { 'cache-control': 'private, max-age=600' } });
}
