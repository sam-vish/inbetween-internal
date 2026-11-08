import { notFound } from 'next/navigation';
import { PremiumQueueButton } from '@/components/PremiumQueueButton';
import { requireOperator } from '@/lib/auth';
import type { ClipRow, MomentRow, StreamRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

function offset(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Stream summary (PRD 4.7): moments, approved clips, approval rate, cost; premium suggestions. */
export default async function StreamSummaryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOperator();
  const { data: stream } = await supabase.from('streams').select('*').eq('id', id).maybeSingle();
  if (!stream) notFound();
  const s = stream as StreamRow;
  const [{ data: client }, { data: moments }, { data: cost }, { data: providers }, { data: quota }] = await Promise.all([
    supabase.from('clients').select('id,name,config').eq('id', s.client_id).maybeSingle(),
    supabase.from('moments').select('*').eq('stream_id', id).order('event_ts'),
    supabase.from('cost_by_stream').select('*').eq('stream_id', id).maybeSingle(),
    supabase.from('cost_by_provider').select('*').eq('stream_id', id),
    supabase.from('quota_events').select('units').eq('stream_id', id),
  ]);
  const ms = (moments ?? []) as MomentRow[];
  const { data: clips } = ms.length
    ? await supabase.from('clips').select('id,moment_id,kind,titles,chosen_title,duration_s,render_ms,created_at').in('moment_id', ms.map((m) => m.id))
    : { data: [] };
  const latestClip = new Map<string, ClipRow>();
  for (const c of (clips ?? []) as ClipRow[]) if (c.moment_id && c.kind === 'fast') latestClip.set(c.moment_id, c);

  const count = (...st: string[]) => ms.filter((m) => st.includes(m.status)).length;
  const approved = count('approved', 'delivered');
  const rejected = count('rejected');
  const reviewed = approved + rejected;
  const hours = Number(cost?.hours ?? 0) || Math.max(0.0167, ((s.ended_at ? Date.parse(s.ended_at) : Date.now()) - Date.parse(s.started_at)) / 3600_000);
  const costUsd = Number(cost?.cost_usd ?? 0);
  const quotaUnits = (quota ?? []).reduce((a, q: any) => a + q.units, 0);
  const renderTimes = [...latestClip.values()].map((c) => c.render_ms ?? 0).filter(Boolean).sort((a, b) => a - b);
  const topN = Number((client as any)?.config?.premium_top_n ?? 5);
  // Premium suggestion: approved/delivered first, then highest score.
  const suggestions = ms
    .filter((m) => ['approved', 'delivered', 'proposed'].includes(m.status))
    .sort((a, b) => (['approved', 'delivered'].includes(b.status) ? 1 : 0) - (['approved', 'delivered'].includes(a.status) ? 1 : 0) || b.score - a.score)
    .slice(0, topN);

  return (
    <div>
      <h1>
        {(client as any)?.name} · {s.title ?? s.video_id} {s.status === 'live' && <span className="badge live">LIVE</span>}
      </h1>
      <div className="grid2">
        <div className="panel">
          <div className="small muted">Moments</div>
          <div className="stat">{ms.length}</div>
          <div className="small">
            {approved} approved · {rejected} rejected · {count('premium')} premium · {count('proposed')} awaiting review
          </div>
        </div>
        <div className="panel">
          <div className="small muted">Approval rate (precision)</div>
          <div className="stat">{reviewed ? Math.round((approved / reviewed) * 100) : 0}%</div>
          <div className="small muted">target ≥ 40% at M2, ≥ 60% at M4</div>
        </div>
        <div className="panel">
          <div className="small muted">Cost</div>
          <div className="stat">${costUsd.toFixed(2)}</div>
          <div className="small">
            ${(costUsd / hours).toFixed(2)}/stream-hour · {hours.toFixed(1)}h · {quotaUnits} YouTube units
          </div>
        </div>
        <div className="panel">
          <div className="small muted">Fast-lane render (p50)</div>
          <div className="stat">{renderTimes.length ? `${Math.round(renderTimes[Math.floor(renderTimes.length / 2)] / 1000)}s` : '—'}</div>
          <div className="small muted">ASR + titles + render + upload</div>
        </div>
      </div>

      <h2>Premium suggestions (top {topN})</h2>
      <div className="panel">
        <ol className="small">
          {suggestions.map((m) => (
            <li key={m.id}>
              {offset(Date.parse(m.event_ts) - Date.parse(s.started_at))} · score {m.score.toFixed(1)} · {m.label ?? m.vision_label ?? ''}{' '}
              <span className={`badge ${m.status}`}>{m.status}</span>
            </li>
          ))}
        </ol>
        <PremiumQueueButton momentIds={suggestions.filter((m) => m.status !== 'premium').map((m) => m.id)} />
      </div>

      <h2>Moments</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>At</th>
              <th>Score</th>
              <th>Label</th>
              <th>Title</th>
              <th>Length</th>
              <th>Paid</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {ms.map((m) => {
              const c = latestClip.get(m.id);
              return (
                <tr key={m.id}>
                  <td className="small">{offset(Date.parse(m.event_ts) - Date.parse(s.started_at))}</td>
                  <td>{m.score.toFixed(1)}</td>
                  <td className="small">{m.label ?? m.vision_label ?? ''}</td>
                  <td className="small">{c?.chosen_title ?? '—'}</td>
                  <td className="small">{c?.duration_s ? `${Math.round(c.duration_s)}s` : '—'}</td>
                  <td>{m.paid_suppressed ? <span className="badge paid">paid</span> : ''}</td>
                  <td>
                    <span className={`badge ${m.status}`}>{m.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Cost by provider</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Calls</th>
              <th>Units</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {(providers ?? []).map((p: any) => (
              <tr key={`${p.provider}-${p.unit_type}`}>
                <td>{p.provider}</td>
                <td>{p.calls}</td>
                <td className="small">
                  {Math.round(Number(p.units))} {p.unit_type}
                </td>
                <td>${Number(p.cost_usd).toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
