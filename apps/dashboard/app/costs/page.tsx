import { requireOperator } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Costs & quota (PRD 4.7 / 4.10): per client, per stream, per stream-hour, by provider; YouTube units today vs quota. */
export default async function CostsPage() {
  const { supabase } = await requireOperator();
  const limit = Number(process.env.YOUTUBE_DAILY_QUOTA ?? 10_000);
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
  const [{ data: today }, { data: byMethod }, { data: streams }, { data: providers }] = await Promise.all([
    supabase.from('quota_today').select('*').maybeSingle(),
    supabase.from('quota_by_method_today').select('*'),
    supabase.from('cost_by_stream').select('*').gte('started_at', since).order('started_at', { ascending: false }),
    supabase.from('cost_by_provider').select('provider,unit_type,units,cost_usd,calls,client_id').gte('last_ts', since),
  ]);
  const used = Number(today?.units_used ?? 0);
  const pct = Math.min(100, (used / limit) * 100);
  const meterClass = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';

  const perClient = new Map<string, { name: string; cost: number; hours: number; streams: number }>();
  for (const s of streams ?? []) {
    const c = perClient.get(s.client_id) ?? { name: s.client_name, cost: 0, hours: 0, streams: 0 };
    c.cost += Number(s.cost_usd);
    c.hours += Number(s.hours);
    c.streams++;
    perClient.set(s.client_id, c);
  }
  const perProvider = new Map<string, { cost: number; units: number; calls: number; unit: string }>();
  for (const p of providers ?? []) {
    const k = p.provider;
    const v = perProvider.get(k) ?? { cost: 0, units: 0, calls: 0, unit: p.unit_type };
    v.cost += Number(p.cost_usd);
    v.units += Number(p.units);
    v.calls += Number(p.calls);
    perProvider.set(k, v);
  }
  const totalCost = [...perClient.values()].reduce((a, c) => a + c.cost, 0);
  const totalHours = [...perClient.values()].reduce((a, c) => a + c.hours, 0);

  return (
    <div>
      <h1>Costs &amp; quota</h1>
      <div className="grid2">
        <div className="panel">
          <h3>YouTube API units today</h3>
          <div className="stat">
            {used.toLocaleString()} <span className="muted small">/ {limit.toLocaleString()} ({pct.toFixed(1)}%)</span>
          </div>
          <div className={`meter ${meterClass}`}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="small muted">
            Resets at midnight Pacific (~13:30 IST). Alert at 70%; new streams start without API chat at 90%. Apply for a quota increase before ~10
            concurrent clients.
          </p>
          <table>
            <tbody>
              {(byMethod ?? []).map((m: any) => (
                <tr key={m.method}>
                  <td>{m.method}</td>
                  <td>{m.calls} calls</td>
                  <td>{m.units} units</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Last 30 days</h3>
          <div className="stat">${totalCost.toFixed(2)}</div>
          <div className="small">
            {totalHours.toFixed(1)} stream-hours · ${totalHours ? (totalCost / totalHours).toFixed(2) : '0.00'} per stream-hour
          </div>
          <table style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Calls</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {[...perProvider.entries()].map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v.calls}</td>
                  <td>${v.cost.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <h2>Per client</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Streams</th>
              <th>Hours</th>
              <th>Cost</th>
              <th>$/stream-hour</th>
            </tr>
          </thead>
          <tbody>
            {[...perClient.entries()].map(([id, c]) => (
              <tr key={id}>
                <td>{c.name}</td>
                <td>{c.streams}</td>
                <td>{c.hours.toFixed(1)}</td>
                <td>${c.cost.toFixed(2)}</td>
                <td>${c.hours ? (c.cost / c.hours).toFixed(2) : '0.00'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Per stream</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Client</th>
              <th>Stream</th>
              <th>Started</th>
              <th>Hours</th>
              <th>Cost</th>
              <th>$/h</th>
            </tr>
          </thead>
          <tbody>
            {(streams ?? []).map((s: any) => (
              <tr key={s.stream_id}>
                <td>{s.client_name}</td>
                <td>
                  <a href={`/streams/${s.stream_id}`}>{s.title ?? s.stream_id.slice(0, 8)}</a>
                </td>
                <td className="small">{new Date(s.started_at).toLocaleString()}</td>
                <td>{Number(s.hours).toFixed(1)}</td>
                <td>${Number(s.cost_usd).toFixed(2)}</td>
                <td>${(Number(s.cost_usd) / Number(s.hours)).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
