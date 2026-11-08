'use client';
/**
 * Client settings (PRD 4.1 / 4.7): the config editor, the facecam crop tester
 * on a live frame (with a 9:16 preview of the chosen layout), delivery, and
 * the client's OAuth consent link.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ClientRow } from '@/lib/types';

type Rect = { x: number; y: number; w: number; h: number };

function num(v: string, fallback: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function ClientSettings({ client, frameKey, live }: { client: ClientRow; frameKey: string | null; live: boolean }) {
  const router = useRouter();
  const [cfg, setCfg] = useState<Record<string, any>>(() => structuredClone(client.config ?? {}));
  const [delivery, setDelivery] = useState(client.delivery ?? { type: 'none', target: '' });
  const [active, setActive] = useState(client.active);
  const [raw, setRaw] = useState(() => JSON.stringify(client.config ?? {}, null, 2));
  const [rawErr, setRawErr] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [frameSrc, setFrameSrc] = useState<string | null>(frameKey ? `/api/media?key=${encodeURIComponent(frameKey)}&v=${Date.now()}` : null);

  const rect: Rect = cfg.facecam_rect ?? { x: 70, y: 0, w: 30, h: 30 };
  const setPath = (path: string[], value: unknown) =>
    setCfg((c) => {
      const next = structuredClone(c);
      let o = next;
      for (const k of path.slice(0, -1)) o = o[k] ??= {};
      o[path[path.length - 1]] = value;
      return next;
    });
  const get = (path: string[], dflt: any) => path.reduce((o, k) => (o == null ? undefined : o[k]), cfg as any) ?? dflt;

  useEffect(() => setRaw(JSON.stringify(cfg, null, 2)), [cfg]);

  async function save() {
    setStatus('saving…');
    const res = await fetch(`/api/clients/${client.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: cfg, delivery, active }),
    });
    const j = await res.json();
    setStatus(res.ok ? 'saved (workers pick it up at the next stream / probe)' : `error: ${j.error}`);
    if (res.ok) router.refresh();
  }

  async function makeLink() {
    const res = await fetch(`/api/clients/${client.id}/link`, { method: 'POST' });
    const j = await res.json();
    if (res.ok) {
      setLink(j.url);
      await navigator.clipboard?.writeText(j.url).catch(() => undefined);
    } else setStatus(`error: ${j.error}`);
  }

  return (
    <div className="grid2">
      <div className="panel">
        <h3>Capture &amp; layout</h3>
        <div className="row">
          <label className="field">
            Layout preset
            <select value={get(['layout_preset'], 'gameplay_only')} onChange={(e) => setPath(['layout_preset'], e.target.value)}>
              <option value="stack">stack (facecam top, gameplay bottom)</option>
              <option value="gameplay_only">gameplay_only</option>
              <option value="facecam_pip">facecam_pip</option>
            </select>
          </label>
          <label className="field">
            Gameplay focus X (0–1)
            <input type="number" step="0.05" min={0} max={1} value={get(['gameplay_focus_x'], 0.5)} onChange={(e) => setPath(['gameplay_focus_x'], num(e.target.value, 0.5))} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(['x', 'y', 'w', 'h'] as const).map((k) => (
            <label className="field" key={k}>
              facecam {k} %
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={rect[k]}
                onChange={(e) => setPath(['facecam_rect'], { ...rect, [k]: num(e.target.value, rect[k]) })}
                style={{ width: 80 }}
              />
            </label>
          ))}
          <button className="btn" onClick={() => setPath(['facecam_rect'], null)}>
            No facecam
          </button>
        </div>
        <FacecamTester src={frameSrc} rect={cfg.facecam_rect ?? null} preset={get(['layout_preset'], 'gameplay_only')} focusX={get(['gameplay_focus_x'], 0.5)} onRect={(r) => setPath(['facecam_rect'], r)} />
        <div className="row small muted" style={{ marginTop: 6 }}>
          {frameKey ? (live ? 'Live frame (refreshes every 30s on the worker).' : 'Last frame from the most recent stream.') : 'No stream frame yet — upload a screenshot instead:'}
          <button className="btn" onClick={() => frameKey && setFrameSrc(`/api/media?key=${encodeURIComponent(frameKey)}&v=${Date.now()}`)}>
            Refresh frame
          </button>
          <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && setFrameSrc(URL.createObjectURL(e.target.files[0]))} />
        </div>
      </div>

      <div className="panel">
        <h3>Captions, titles &amp; delivery</h3>
        <div className="row">
          <label className="field">
            Caption language
            <select value={get(['caption_language'], 'en')} onChange={(e) => setPath(['caption_language'], e.target.value)}>
              <option value="en">en</option>
              <option value="hi">hi (Devanagari)</option>
              <option value="hinglish">hinglish (Latin script)</option>
              <option value="pt-BR">pt-BR</option>
              <option value="es">es</option>
            </select>
          </label>
          <label className="field">
            Caption style
            <select value={get(['caption_style'], 'bold_yellow')} onChange={(e) => setPath(['caption_style'], e.target.value)}>
              <option value="bold_yellow">bold_yellow</option>
              <option value="clean_white">clean_white</option>
              <option value="hype_red">hype_red</option>
            </select>
          </label>
          <label className="field">
            Game
            <input value={get(['game'], '') ?? ''} onChange={(e) => setPath(['game'], e.target.value || null)} placeholder="GTA VI" />
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="field">
            Delivery
            <select value={delivery.type} onChange={(e) => setDelivery({ ...delivery, type: e.target.value })}>
              <option value="telegram">Telegram chat</option>
              <option value="discord">Discord webhook</option>
              <option value="drive">Google Drive folder</option>
              <option value="none">none</option>
            </select>
          </label>
          {delivery.type !== 'none' && (
            <label className="field" style={{ flex: 1 }}>
              Target
              <input value={delivery.target} onChange={(e) => setDelivery({ ...delivery, target: e.target.value })} />
            </label>
          )}
        </div>
        <h3 style={{ marginTop: 14 }}>Scoring</h3>
        <div className="row">
          <label className="field">
            Score threshold
            <input type="number" step="0.5" value={get(['thresholds', 'score'], 4.5)} onChange={(e) => setPath(['thresholds', 'score'], num(e.target.value, 4.5))} style={{ width: 90 }} />
          </label>
          <label className="field">
            Cooldown s
            <input type="number" value={get(['thresholds', 'cooldown_s'], 45)} onChange={(e) => setPath(['thresholds', 'cooldown_s'], num(e.target.value, 45))} style={{ width: 80 }} />
          </label>
          <label className="field">
            Max clips/hour
            <input type="number" value={get(['thresholds', 'max_clips_per_hour'], 12)} onChange={(e) => setPath(['thresholds', 'max_clips_per_hour'], num(e.target.value, 12))} style={{ width: 80 }} />
          </label>
          <label className="field">
            Chat lag s
            <input type="number" value={get(['timing', 'chat_lag_s'], 8)} onChange={(e) => setPath(['timing', 'chat_lag_s'], num(e.target.value, 8))} style={{ width: 70 }} />
          </label>
          <label className="field">
            Cost cap $/stream
            <input type="number" step="0.5" value={get(['cost_cap_usd'], 3)} onChange={(e) => setPath(['cost_cap_usd'], num(e.target.value, 3))} style={{ width: 80 }} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          {(['chat_rate', 'chat_reaction', 'chat_caps', 'audio_loud', 'voice_hype', 'vision_event'] as const).map((k) => (
            <label className="field" key={k}>
              w {k}
              <input
                type="number"
                step="0.1"
                value={get(['weights', k], { chat_rate: 1, chat_reaction: 0.8, chat_caps: 0.4, audio_loud: 0.8, voice_hype: 0.6, vision_event: 2 }[k])}
                onChange={(e) => setPath(['weights', k], num(e.target.value, 1))}
                style={{ width: 70 }}
              />
            </label>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="row small">
            <input type="checkbox" checked={get(['vision', 'enabled'], true)} onChange={(e) => setPath(['vision', 'enabled'], e.target.checked)} /> vision
          </label>
          <label className="field">
            Game profile
            <select value={get(['vision', 'game_profile'], 'generic')} onChange={(e) => setPath(['vision', 'game_profile'], e.target.value)}>
              <option value="generic">generic</option>
              <option value="gta6">gta6</option>
              <option value="gta5rp">gta5rp</option>
            </select>
          </label>
          <label className="field">
            Chat auth
            <select value={get(['chat_auth'], 'api_key')} onChange={(e) => setPath(['chat_auth'], e.target.value)}>
              <option value="api_key">API key</option>
              <option value="oauth">client OAuth</option>
            </select>
          </label>
          <label className="row small">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> active (watch for go-live)
          </label>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={save}>
            Save settings
          </button>
          {status && <span className="small muted">{status}</span>}
        </div>
      </div>

      <div className="panel">
        <h3>Consent (Google OAuth, read-only)</h3>
        <p className="small">
          {client.consent_at ? (
            <>
              Connected {client.oauth_channel_title ? <b>{client.oauth_channel_title}</b> : null} on {new Date(client.consent_at).toLocaleString()}.
            </>
          ) : (
            <span className="error">Not connected yet. Ingest only authorized channels (PRD §6).</span>
          )}
        </p>
        <button className="btn" onClick={makeLink}>
          {client.consent_at ? 'New consent link' : 'Create consent link'}
        </button>
        {link && (
          <p className="small" style={{ wordBreak: 'break-all' }}>
            Copied: <a href={link}>{link}</a>
          </p>
        )}
      </div>

      <div className="panel">
        <h3>Advanced config (JSON)</h3>
        <p className="small muted">Reaction weights, hype phrases, member emojis, timing, active hours… Validated on save.</p>
        <textarea
          rows={16}
          value={raw}
          onChange={(e) => {
            setRaw(e.target.value);
            try {
              setCfg(JSON.parse(e.target.value));
              setRawErr(null);
            } catch (err) {
              setRawErr((err as Error).message);
            }
          }}
        />
        {rawErr && <div className="error small">{rawErr}</div>}
      </div>
    </div>
  );
}

/** Draws the frame with the facecam rect, plus a 9:16 preview of the layout. Drag on the frame to draw the rect. */
function FacecamTester({ src, rect, preset, focusX, onRect }: { src: string | null; rect: Rect | null; preset: string; focusX: number; onRect(r: Rect): void }) {
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [loaded, setLoaded] = useState(0);

  useEffect(() => {
    const img = imgRef.current;
    const c = canvasRef.current;
    if (!img || !c || !img.naturalWidth) return;
    const ctx = c.getContext('2d')!;
    const W = 1080 / 4;
    const H = 1920 / 4;
    c.width = W;
    c.height = H;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const gameCrop = (outW: number, outH: number) => {
      const h = ih;
      const w = Math.min(iw, (ih * outW) / outH);
      const x = Math.min(iw - w, Math.max(0, focusX * iw - w / 2));
      return { x, y: 0, w, h };
    };
    const face = rect ? { x: (rect.x / 100) * iw, y: (rect.y / 100) * ih, w: (rect.w / 100) * iw, h: (rect.h / 100) * ih } : null;
    if (preset === 'stack' && face) {
      const faceH = H * 0.38;
      // cover-fit the facecam into W×faceH
      const s = Math.max(W / face.w, faceH / face.h);
      const sw = W / s;
      const sh = faceH / s;
      ctx.drawImage(img, face.x + (face.w - sw) / 2, face.y + (face.h - sh) / 2, sw, sh, 0, 0, W, faceH);
      const g = gameCrop(W, H - faceH);
      ctx.drawImage(img, g.x, g.y, g.w, g.h, 0, faceH, W, H - faceH);
    } else {
      const g = gameCrop(W, H);
      ctx.drawImage(img, g.x, g.y, g.w, g.h, 0, 0, W, H);
      if (preset === 'facecam_pip' && face) {
        const pw = W * 0.39;
        const ph = (pw * face.h) / face.w;
        ctx.drawImage(img, face.x, face.y, face.w, face.h, W - pw - 10, H * 0.17, pw, ph);
      }
    }
  }, [rect, preset, focusX, loaded]);

  const toPct = (e: React.MouseEvent) => {
    const r = (e.target as HTMLElement).getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };

  if (!src) return <div className="placeholder small muted" style={{ marginTop: 10 }}>No frame available.</div>;
  return (
    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="small muted">Drag on the frame to draw the facecam rectangle.</div>
      <div
        className="crop-wrap"
        style={{ width: '100%', cursor: 'crosshair' }}
        onMouseDown={(e) => setDrag(toPct(e))}
        onMouseUp={(e) => {
          if (!drag) return;
          const p = toPct(e);
          const r = { x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) };
          setDrag(null);
          if (r.w > 2 && r.h > 2) onRect({ x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.w.toFixed(1), h: +r.h.toFixed(1) });
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img ref={imgRef} src={src} alt="latest stream frame" crossOrigin="anonymous" onLoad={() => setLoaded((n) => n + 1)} draggable={false} />
        {rect && <div className="crop-rect" style={{ left: `${rect.x}%`, top: `${rect.y}%`, width: `${rect.w}%`, height: `${rect.h}%` }} />}
      </div>
      <div>
        <div className="small muted">9:16 preview</div>
        <canvas ref={canvasRef} style={{ borderRadius: 6, border: '1px solid var(--line)' }} />
      </div>
    </div>
  );
}
