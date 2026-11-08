import { LiveBoard } from '@/components/LiveBoard';
import { requireOperator } from '@/lib/auth';
import type { ClipRow, MomentRow, StreamRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  const { supabase } = await requireOperator();
  const since = new Date(Date.now() - 3 * 3600_000).toISOString();
  const { data: streams } = await supabase
    .from('streams')
    .select('id,client_id,platform,video_id,title,started_at,ended_at,status,summary,game')
    .or(`status.eq.live,ended_at.gte.${since}`)
    .order('started_at', { ascending: false });
  const streamIds = (streams ?? []).map((s) => s.id);
  const { data: moments } = streamIds.length
    ? await supabase.from('moments').select('*').in('stream_id', streamIds).order('event_ts', { ascending: false }).limit(400)
    : { data: [] };
  const momentIds = (moments ?? []).map((m) => m.id);
  const { data: clips } = momentIds.length
    ? await supabase
        .from('clips')
        .select('id,moment_id,client_id,stream_id,kind,r2_key,thumb_key,titles,chosen_title,burned_title,language,duration_s,render_ms,needs_review,created_at')
        .in('moment_id', momentIds)
        .order('created_at', { ascending: true })
    : { data: [] };
  const { data: clients } = await supabase.from('clients').select('id,name');

  return (
    <LiveBoard
      initialStreams={(streams ?? []) as StreamRow[]}
      initialMoments={(moments ?? []) as MomentRow[]}
      initialClips={(clips ?? []) as ClipRow[]}
      clients={(clients ?? []) as Array<{ id: string; name: string }>}
    />
  );
}
