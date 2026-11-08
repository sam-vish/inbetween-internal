'use client';
/**
 * Live board (PRD 4.7): one column per live client; moment cards stream in
 * through Supabase Realtime. Keyboard-first so an approval takes < 30s:
 *   J/K or ↓/↑  select      A approve     R reject      1/2/3 pick title
 *   E edit title            ←/→ nudge end ±1s   Shift+←/→ nudge start ±1s
 *   T apply trim (re-render)                    P send to premium   Space play/pause
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabaseBrowser } from '@/lib/supabase/browser';
import type { ClipRow, MomentRow, StreamRow } from '@/lib/types';
import { type CardUiState, defaultUi, MomentCard } from './MomentCard';

interface Props {
  initialStreams: StreamRow[];
  initialMoments: MomentRow[];
  initialClips: ClipRow[];
  clients: Array<{ id: string; name: string }>;
}

export function LiveBoard({ initialStreams, initialMoments, initialClips, clients }: Props) {
  const [streams, setStreams] = useState(() => new Map(initialStreams.map((s) => [s.id, s])));
  const [moments, setMoments] = useState(() => new Map(initialMoments.map((m) => [m.id, m])));
  const [clips, setClips] = useState(() => {
    const map = new Map<string, ClipRow>();
    for (const c of initialClips) if (c.moment_id && c.kind === 'fast') map.set(c.moment_id, c);
    return map;
  });
  const [premiumClips, setPremiumClips] = useState(() => {
    const map = new Map<string, ClipRow>();
    for (const c of initialClips) if (c.moment_id && c.kind === 'premium') map.set(c.moment_id, c);
    return map;
  });
  const [ui, setUi] = useState<Record<string, CardUiState>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);

  // ---- realtime ----
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return; // not configured (e.g. local preview)
    const sb = supabaseBrowser();
    const ch = sb
      .channel('live-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'moments' }, (p) => {
        const row = (p.new ?? p.old) as MomentRow;
        if (!row?.id) return;
        setMoments((prev) => {
          const next = new Map(prev);
          if (p.eventType === 'DELETE') next.delete(row.id);
          else next.set(row.id, { ...(prev.get(row.id) ?? {}), ...(p.new as MomentRow) });
          return next;
        });
        // Clear the optimistic "pending" label once the server state moves.
        if (p.eventType === 'UPDATE') setUi((u) => (u[row.id]?.pending ? { ...u, [row.id]: { ...u[row.id], pending: null } } : u));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'clips' }, (p) => {
        const c = p.new as ClipRow;
        if (!c?.moment_id) return;
        if (c.kind === 'premium') setPremiumClips((prev) => new Map(prev).set(c.moment_id!, c));
        else if (c.kind === 'fast')
          setClips((prev) => {
            const cur = prev.get(c.moment_id!);
            if (cur && cur.id !== c.id && Date.parse(cur.created_at) > Date.parse(c.created_at)) return prev;
            return new Map(prev).set(c.moment_id!, c);
          });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'streams' }, (p) => {
        const s = p.new as StreamRow;
        if (s?.id) setStreams((prev) => new Map(prev).set(s.id, { ...(prev.get(s.id) ?? {}), ...s }));
      })
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'));
    return () => {
      void sb.removeChannel(ch);
    };
  }, []);

  // ---- columns ----
  const columns = useMemo(() => {
    const byStream = new Map<string, MomentRow[]>();
    for (const m of moments.values()) {
      const list = byStream.get(m.stream_id) ?? [];
      list.push(m);
      byStream.set(m.stream_id, list);
    }
    for (const list of byStream.values()) list.sort((a, b) => Date.parse(b.event_ts) - Date.parse(a.event_ts));
    return [...streams.values()]
      .sort((a, b) => (a.status === 'live' ? 0 : 1) - (b.status === 'live' ? 0 : 1) || Date.parse(b.started_at) - Date.parse(a.started_at))
      .map((s) => ({ stream: s, moments: byStream.get(s.id) ?? [] }));
  }, [streams, moments]);

  const order = useMemo(() => columns.flatMap((c) => c.moments.map((m) => m.id)), [columns]);
  const getUi = useCallback((id: string) => ui[id] ?? defaultUi(), [ui]);
  const patchUi = useCallback((id: string, patch: Partial<CardUiState>) => setUi((u) => ({ ...u, [id]: { ...(u[id] ?? defaultUi()), ...patch } })), []);

  const act = useCallback(
    async (momentId: string, action: string, payload: Record<string, unknown> = {}) => {
      const clip = action === 'approve' && premiumClips.get(momentId)?.needs_review ? premiumClips.get(momentId)! : clips.get(momentId);
      patchUi(momentId, { pending: `${action}…` });
      const res = await fetch('/api/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ momentId, clipId: clip?.id ?? null, action, payload }),
      });
      if (!res.ok) {
        patchUi(momentId, { pending: null });
        setToast(`${action} failed: ${(await res.json().catch(() => ({}))).error ?? res.status}`);
        return;
      }
      if (action === 'trim') patchUi(momentId, { trimStart: 0, trimEnd: 0 });
      setToast(`${action} queued`);
      setTimeout(() => setToast(null), 2000);
    },
    [clips, premiumClips, patchUi],
  );

  const select = useCallback((id: string | null) => {
    setSelected(id);
    if (id) cardRefs.current.get(id)?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, []);

  // ---- keyboard ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = selected ? order.indexOf(selected) : -1;
      const id = selected;
      const key = e.key;
      if (key === 'j' || key === 'ArrowDown') {
        select(order[Math.min(order.length - 1, idx + 1)] ?? null);
        e.preventDefault();
        return;
      }
      if (key === 'k' || key === 'ArrowUp') {
        select(order[Math.max(0, idx - 1)] ?? null);
        e.preventDefault();
        return;
      }
      if (!id) return;
      const u = getUi(id);
      const clip = clips.get(id);
      switch (key) {
        case 'a':
        case 'A': {
          const title = u.editedTitle ?? clip?.titles?.[u.titleIndex] ?? clip?.chosen_title;
          void act(id, 'approve', title ? { title } : {});
          select(order[idx + 1] ?? id);
          break;
        }
        case 'r':
        case 'R':
          void act(id, 'reject');
          select(order[idx + 1] ?? id);
          break;
        case '1':
        case '2':
        case '3':
          patchUi(id, { titleIndex: Number(key) - 1, editedTitle: null });
          break;
        case 'e':
        case 'E':
          cardRefs.current.get(id)?.querySelector<HTMLInputElement>('input[data-title-input]')?.focus();
          e.preventDefault();
          break;
        case 'ArrowLeft':
          if (e.shiftKey) patchUi(id, { trimStart: Math.max(-5, u.trimStart - 1) });
          else patchUi(id, { trimEnd: Math.max(-5, u.trimEnd - 1) });
          e.preventDefault();
          break;
        case 'ArrowRight':
          if (e.shiftKey) patchUi(id, { trimStart: Math.min(5, u.trimStart + 1) });
          else patchUi(id, { trimEnd: Math.min(5, u.trimEnd + 1) });
          e.preventDefault();
          break;
        case 't':
        case 'T':
          if (u.trimStart || u.trimEnd) void act(id, 'trim', { startDeltaS: u.trimStart, endDeltaS: u.trimEnd });
          break;
        case 'p':
        case 'P':
          void act(id, 'premium');
          break;
        case ' ': {
          const v = cardRefs.current.get(id)?.querySelector('video');
          if (v) (v.paused ? v.play() : v.pause())?.catch?.(() => undefined);
          e.preventDefault();
          break;
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, order, getUi, clips, act, patchUi, select]);

  useEffect(() => {
    if (!selected && order.length) {
      const firstOpen = order.find((id) => moments.get(id)?.status === 'proposed') ?? order[0];
      setSelected(firstOpen);
    }
  }, [order, selected, moments]);

  const pendingCount = [...moments.values()].filter((m) => m.status === 'proposed').length;

  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="row">
          <h1 style={{ margin: 0 }}>Live board</h1>
          <span className={`badge ${connected ? 'approved' : 'rendering'}`}>{connected ? 'realtime connected' : 'connecting…'}</span>
          <span className="badge proposed">{pendingCount} awaiting review</span>
          {toast && <span className="small muted">{toast}</span>}
        </div>
        <div className="help">
          <span><kbd>J</kbd>/<kbd>K</kbd> move</span>
          <span><kbd>A</kbd> approve</span>
          <span><kbd>R</kbd> reject</span>
          <span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> title</span>
          <span><kbd>E</kbd> edit title</span>
          <span><kbd>←</kbd>/<kbd>→</kbd> end ±1s</span>
          <span><kbd>⇧←</kbd>/<kbd>⇧→</kbd> start ±1s</span>
          <span><kbd>T</kbd> trim</span>
          <span><kbd>P</kbd> premium</span>
        </div>
      </div>
      {columns.length === 0 ? (
        <div className="panel muted">No live streams right now. Workers check every client's channel every minute.</div>
      ) : (
        <div className="board">
          {columns.map(({ stream, moments: list }) => (
            <div className="column" key={stream.id}>
              <div className="column-head">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>{clientName.get(stream.client_id) ?? 'Client'}</b>
                  <span className={`badge ${stream.status === 'live' ? 'live' : ''}`}>{stream.status === 'live' ? 'LIVE' : 'ended'}</span>
                </div>
                <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {stream.title ?? stream.video_id} · <a href={`/streams/${stream.id}`}>summary</a>
                </div>
              </div>
              {list.length === 0 && <div className="panel small muted">Watching… no moments yet.</div>}
              {list.map((m) => (
                <MomentCard
                  key={m.id}
                  ref={(el) => {
                    if (el) cardRefs.current.set(m.id, el);
                    else cardRefs.current.delete(m.id);
                  }}
                  moment={m}
                  clip={premiumClips.get(m.id)?.needs_review ? premiumClips.get(m.id)! : (clips.get(m.id) ?? null)}
                  streamStartedAt={stream.started_at}
                  ui={getUi(m.id)}
                  selected={selected === m.id}
                  onSelect={() => setSelected(m.id)}
                  onUi={(patch) => patchUi(m.id, patch)}
                  onAction={(action, payload) => void act(m.id, action, payload)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
