import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  const supabase = await supabaseServer();
  await supabase.auth.signOut();
  const to = request.nextUrl.clone();
  to.pathname = '/login';
  to.search = '';
  return NextResponse.redirect(to, { status: 303 });
}
