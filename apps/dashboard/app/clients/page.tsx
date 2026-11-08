import Link from 'next/link';
import { NewClientForm } from '@/components/NewClientForm';
import { requireOperator } from '@/lib/auth';
import { CLIENT_COLUMNS, type ClientRow } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  const { supabase } = await requireOperator();
  const { data } = await supabase.from('clients').select(CLIENT_COLUMNS).order('created_at', { ascending: false });
  const { data: live } = await supabase.from('streams').select('client_id').eq('status', 'live');
  const liveSet = new Set((live ?? []).map((s) => s.client_id));
  const clients = (data ?? []) as ClientRow[];
  return (
    <div>
      <h1>Clients</h1>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Channel</th>
              <th>Consent</th>
              <th>Layout</th>
              <th>Captions</th>
              <th>Delivery</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link href={`/clients/${c.id}`}>{c.name}</Link>
                </td>
                <td className="small">
                  <a href={`https://www.youtube.com/channel/${c.youtube_channel_id}`} target="_blank" rel="noreferrer">
                    {c.oauth_channel_title ?? c.youtube_channel_id}
                  </a>
                </td>
                <td className="small">{c.consent_at ? new Date(c.consent_at).toLocaleDateString() : <span className="error">missing</span>}</td>
                <td className="small">{c.config?.layout_preset ?? 'gameplay_only'}</td>
                <td className="small">{c.config?.caption_language ?? 'en'}</td>
                <td className="small">{c.delivery?.type ?? 'none'}</td>
                <td>
                  {liveSet.has(c.id) ? <span className="badge live">LIVE</span> : c.active ? <span className="badge">watching</span> : <span className="badge">paused</span>}
                </td>
              </tr>
            ))}
            {!clients.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <h2>Add a client</h2>
      <NewClientForm />
    </div>
  );
}
