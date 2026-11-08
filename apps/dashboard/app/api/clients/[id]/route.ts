import { ClientConfigSchema, DeliveryTargetSchema } from '@inbetween/shared/config';
import { NextResponse, type NextRequest } from 'next/server';
import { operatorOrNull } from '@/lib/auth';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await operatorOrNull();
  if (!auth) return NextResponse.json({ error: 'not an operator' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.youtube_channel_id === 'string') {
    if (!/^UC[A-Za-z0-9_-]{22}$/.test(body.youtube_channel_id)) return NextResponse.json({ error: 'invalid channel id' }, { status: 400 });
    patch.youtube_channel_id = body.youtube_channel_id;
  }
  if (typeof body.active === 'boolean') patch.active = body.active;
  if (body.config !== undefined) {
    const parsed = ClientConfigSchema.safeParse(body.config);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    patch.config = parsed.data;
  }
  if (body.delivery !== undefined) {
    const parsed = DeliveryTargetSchema.safeParse(body.delivery);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    patch.delivery = parsed.data;
  }
  const { error } = await auth.supabase.from('clients').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
