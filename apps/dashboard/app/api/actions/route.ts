import { NextResponse, type NextRequest } from 'next/server';
import { operatorOrNull } from '@/lib/auth';

const ACTIONS = new Set(['approve', 'reject', 'trim', 'title', 'premium', 'rerender', 'deliver']);

/**
 * Queues an operator action. The row is inserted with the operator's own
 * session (RLS: operators only); a worker claims and executes it.
 */
export async function POST(request: NextRequest) {
  const auth = await operatorOrNull();
  if (!auth) return NextResponse.json({ error: 'not an operator' }, { status: 403 });
  const body = (await request.json().catch(() => null)) as {
    momentId?: string;
    clipId?: string | null;
    action?: string;
    payload?: Record<string, unknown>;
  } | null;
  if (!body?.action || !ACTIONS.has(body.action) || (!body.momentId && !body.clipId)) {
    return NextResponse.json({ error: 'invalid action' }, { status: 400 });
  }
  const payload = body.payload ?? {};
  if (body.action === 'trim') {
    const s = Number(payload.startDeltaS ?? 0);
    const e = Number(payload.endDeltaS ?? 0);
    if (!Number.isFinite(s) || !Number.isFinite(e) || Math.abs(s) > 10 || Math.abs(e) > 10) {
      return NextResponse.json({ error: 'trim deltas must be within ±10s' }, { status: 400 });
    }
  }
  if ((body.action === 'title' || (body.action === 'approve' && payload.title != null)) && String(payload.title ?? '').length > 120) {
    return NextResponse.json({ error: 'title too long' }, { status: 400 });
  }
  const { data, error } = await auth.supabase
    .from('operator_actions')
    .insert({
      moment_id: body.momentId ?? null,
      clip_id: body.clipId ?? null,
      action: body.action,
      payload,
      operator_email: auth.operator.email,
    })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data.id });
}
