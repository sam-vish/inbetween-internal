import { redirect } from 'next/navigation';
import { supabaseServer } from './supabase/server';

export interface Operator {
  id: string;
  email: string;
  role: 'operator' | 'admin';
}

/**
 * Operators only (PRD 4.7): signed in AND on the `operators` allowlist.
 * The `operators` RLS policy only returns rows to allowlisted users, so an
 * empty result means "signed in but not allowed".
 */
export async function requireOperator(): Promise<{ operator: Operator; supabase: Awaited<ReturnType<typeof supabaseServer>> }> {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) redirect('/login');
  const { data } = await supabase.from('operators').select('id,email,role').ilike('email', user.email).maybeSingle();
  if (!data) redirect('/login?denied=1');
  return { operator: data as Operator, supabase };
}

/** Same check for route handlers: returns null instead of redirecting. */
export async function operatorOrNull() {
  const supabase = await supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.email) return null;
  const { data } = await supabase.from('operators').select('id,email,role').ilike('email', user.email).maybeSingle();
  return data ? { operator: data as Operator, supabase } : null;
}
