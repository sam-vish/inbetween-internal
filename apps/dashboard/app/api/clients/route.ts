import { ClientConfigSchema, DeliveryTargetSchema } from '@inbetween/shared/config';
import { NextResponse, type NextRequest } from 'next/server';
import { operatorOrNull } from '@/lib/auth';

export async function POST(request: NextRequest) {
  const auth = await operatorOrNull();
  if (!auth) return NextResponse.json({ error: 'not an operator' }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const name = String(body.name ?? '').trim();
  const channel = String(body.youtube_channel_id ?? '').trim();
  if (!name || !/^UC[A-Za-z0-9_-]{22}$/.test(channel)) {
    return NextResponse.json({ error: 'name and a valid YouTube channel ID (UC…, 24 chars) are required' }, { status: 400 });
  }
  const config = ClientConfigSchema.safeParse(body.config ?? {});
  if (!config.success) return NextResponse.json({ error: config.error.message }, { status: 400 });
  const delivery = DeliveryTargetSchema.safeParse(body.delivery ?? { type: 'none', target: '' });
  if (!delivery.success) return NextResponse.json({ error: delivery.error.message }, { status: 400 });
  const { data, error } = await auth.supabase
    .from('clients')
    .insert({ name, youtube_channel_id: channel, config: config.data, delivery: delivery.data, active: true })
    .select('id')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ id: data.id });
}
