'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewClientForm() {
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    youtube_channel_id: '',
    layout_preset: 'stack',
    caption_language: 'hinglish',
    delivery_type: 'telegram',
    delivery_target: '',
  });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: form.name,
        youtube_channel_id: form.youtube_channel_id.trim(),
        config: { layout_preset: form.layout_preset, caption_language: form.caption_language },
        delivery: form.delivery_type === 'none' ? { type: 'none', target: '' } : { type: form.delivery_type, target: form.delivery_target },
      }),
    });
    const j = await res.json();
    setBusy(false);
    if (!res.ok) return setErr(j.error ?? 'failed');
    router.push(`/clients/${j.id}`);
  }

  return (
    <form className="panel row" onSubmit={submit} style={{ alignItems: 'flex-end' }}>
      <label className="field">
        Name
        <input required value={form.name} onChange={set('name')} />
      </label>
      <label className="field">
        YouTube channel ID
        <input required value={form.youtube_channel_id} onChange={set('youtube_channel_id')} placeholder="UC…" size={28} />
      </label>
      <label className="field">
        Layout
        <select value={form.layout_preset} onChange={set('layout_preset')}>
          <option value="stack">stack</option>
          <option value="gameplay_only">gameplay_only</option>
          <option value="facecam_pip">facecam_pip</option>
        </select>
      </label>
      <label className="field">
        Captions
        <select value={form.caption_language} onChange={set('caption_language')}>
          <option value="en">en</option>
          <option value="hi">hi (Devanagari)</option>
          <option value="hinglish">hinglish (Latin)</option>
          <option value="pt-BR">pt-BR</option>
          <option value="es">es</option>
        </select>
      </label>
      <label className="field">
        Delivery
        <select value={form.delivery_type} onChange={set('delivery_type')}>
          <option value="telegram">Telegram chat</option>
          <option value="discord">Discord webhook</option>
          <option value="drive">Drive folder</option>
          <option value="none">none</option>
        </select>
      </label>
      {form.delivery_type !== 'none' && (
        <label className="field">
          {form.delivery_type === 'telegram' ? 'Chat ID' : form.delivery_type === 'discord' ? 'Webhook URL' : 'Folder ID'}
          <input required value={form.delivery_target} onChange={set('delivery_target')} size={30} />
        </label>
      )}
      <button className="btn primary" disabled={busy}>
        Add client
      </button>
      {err && <span className="error small">{err}</span>}
    </form>
  );
}
