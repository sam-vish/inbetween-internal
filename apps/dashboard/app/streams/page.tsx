import Link from 'next/link';
import { requireOperator } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function StreamsPage() {
  const { supabase } = await requireOperator();
  const { data: rows } = await supabase.from('cost_by_stream').select('*').order('started_at', { ascending: false }).limit(100);
  const { data: streams } = await supabase.from('streams').select('id,status,summary').order('started_at', { ascending: false }).limit(100);
  const byId = new Map((streams ?? []).map((s) => [s.id, s]));
  return (
    <div>
      <h1>Streams</h1>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Stream</th>
              <th>Started</th>
              <th>Hours</th>
              <th>Moments</th>
              <th>Approved</th>
              <th>Cost</th>
              <th>$/h</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r: any) => {
              const s = byId.get(r.stream_id);
              const sum = s?.summary as Record<string, number> | null;
              return (
                <tr key={r.stream_id}>
                  <td>{r.client_name}</td>
                  <td>
                    <Link href={`/streams/${r.stream_id}`}>{r.title ?? r.stream_id.slice(0, 8)}</Link>
                  </td>
                  <td className="small">{new Date(r.started_at).toLocaleString()}</td>
                  <td>{Number(r.hours).toFixed(1)}</td>
                  <td>{sum?.moments ?? '—'}</td>
                  <td>{sum ? `${sum.approved} (${Math.round((sum.approvalRate ?? 0) * 100)}%)` : '—'}</td>
                  <td>${Number(r.cost_usd).toFixed(2)}</td>
                  <td>${(Number(r.cost_usd) / Number(r.hours)).toFixed(2)}</td>
                  <td>{s?.status === 'live' ? <span className="badge live">LIVE</span> : <span className="badge">{s?.status}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
