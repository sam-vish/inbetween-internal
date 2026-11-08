import { notFound } from 'next/navigation';
import { ClientSettings } from '@/components/ClientSettings';
import { DeliverButton } from '@/components/DeliverButton';
import { requireOperator } from '@/lib/auth';
import { CLIENT_COLUMNS, type ClientRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOperator();
  const { data } = await supabase.from('clients').select(CLIENT_COLUMNS).eq('id', id).maybeSingle();
  if (!data) notFound();
  const { data: streams } = await supabase
    .from('streams')
    .select('id,status,started_at,title')
    .eq('client_id', id)
    .order('started_at', { ascending: false })
    .limit(10);
  const { data: compilations } = await supabase
    .from('clips')
    .select('id,r2_key,chosen_title,duration_s,needs_review,created_at')
    .eq('client_id', id)
    .eq('kind', 'compilation')
    .order('created_at', { ascending: false })
    .limit(10);
  const live = (streams ?? []).find((s) => s.status === 'live') ?? null;
  const latest = live ?? (streams ?? [])[0] ?? null;
  return (
    <div>
      <h1>{(data as ClientRow).name}</h1>
      <ClientSettings client={data as ClientRow} frameKey={latest ? `live/${latest.id}/latest.jpg` : null} live={!!live} />
      <h2>Weekly compilations</h2>
      <div className="panel">
        {(compilations ?? []).length === 0 && <p className="small muted">None yet. Run `pnpm --filter @inbetween/premium compile --client {id}`.</p>}
        {(compilations ?? []).map((c) => (
          <div key={c.id} className="row" style={{ marginBottom: 10, alignItems: 'flex-start' }}>
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={`/api/media?key=${encodeURIComponent(c.r2_key)}`} controls preload="metadata" style={{ width: 360, borderRadius: 8 }} />
            <div>
              <div>{c.chosen_title}</div>
              <div className="small muted">
                {new Date(c.created_at).toLocaleString()} · {Math.round((c.duration_s ?? 0) / 60)} min
              </div>
              {c.needs_review ? <DeliverButton clipId={c.id} /> : <span className="badge delivered">delivered</span>}
            </div>
          </div>
        ))}
      </div>
      <h2>Recent streams</h2>
      <div className="panel">
        <table>
          <tbody>
            {(streams ?? []).map((s) => (
              <tr key={s.id}>
                <td>
                  <a href={`/streams/${s.id}`}>{s.title ?? s.id}</a>
                </td>
                <td className="small">{new Date(s.started_at).toLocaleString()}</td>
                <td>{s.status === 'live' ? <span className="badge live">LIVE</span> : <span className="badge">{s.status}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
