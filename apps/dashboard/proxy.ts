/**
 * Next 16 Proxy (formerly middleware): refreshes the Supabase session cookie
 * and sends signed-out users to /login. Authorization (operator allowlist) is
 * enforced again server-side in pages/route handlers and by RLS.
 */
import { createServerClient } from '@supabase/ssr';
import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC = [/^\/login/, /^\/auth\//, /^\/api\/oauth\//, /^\/connect\//, /^\/_next\//, /^\/favicon/];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return response;
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;
  if (!user && !PUBLIC.some((re) => re.test(path))) {
    const to = request.nextUrl.clone();
    to.pathname = '/login';
    to.search = '';
    return NextResponse.redirect(to);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
