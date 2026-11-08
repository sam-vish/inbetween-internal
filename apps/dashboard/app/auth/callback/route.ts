import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

/** Magic-link landing: exchanges the auth code for a session cookie. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const to = request.nextUrl.clone();
  to.search = '';
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    to.pathname = error ? '/login' : '/';
  } else {
    to.pathname = '/login';
  }
  return NextResponse.redirect(to);
}
