'use client';
import { forwardRef } from 'react';
import type { ClipRow, MomentRow } from '@/lib/types';
import { BreakdownBar } from './BreakdownBar';

export interface CardUiState {
  titleIndex: number;
  editedTitle: string | null;
  trimStart: number;
  trimEnd: number;
  pending: string | null;
}

export const defaultUi = (): CardUiState => ({ titleIndex: 0, editedTitle: null, trimStart: 0, trimEnd: 0, pending: null });

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface Props {
  moment: MomentRow;
  clip: ClipRow | null;
  streamStartedAt: string;
  ui: CardUiState;
  selected: boolean;
  onSelect(): void;
  onUi(patch: Partial<CardUiState>): void;
  onAction(action: string, payload?: Record<string, unknown>): void;
}

export const MomentCard = forwardRef<HTMLDivElement, Props>(function MomentCard(
  { moment: m, clip, streamStartedAt, ui, selected, onSelect, onUi, onAction },
  ref,
) {
  const titles = clip?.titles?.length ? clip.titles : [];
  const chosen = ui.editedTitle ?? titles[ui.titleIndex] ?? clip?.chosen_title ?? '';
  const durS = (Date.parse(m.end_ts) - Date.parse(m.start_ts)) / 1000 - ui.trimStart + ui.trimEnd;
  const offsetS = Math.max(0, (Date.parse(m.event_ts) - Date.parse(streamStartedAt)) / 1000);
  const offsetLabel = `${Math.floor(offsetS / 3600)}:${String(Math.floor((offsetS % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(offsetS % 60)).padStart(2, '0')}`;
  const done = ['rejected', 'delivered'].includes(m.status);
  const busy = m.status === 'rendering' || m.status === 'detected' || !!ui.pending;

  return (
    <div ref={ref} className={`card ${selected ? 'selected' : ''} ${done ? 'dim' : ''}`} onClick={onSelect} tabIndex={-1}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="row">
          <span className={`badge ${m.status}`}>{ui.pending ?? m.status}</span>
          {m.paid_suppressed && <span className="badge paid" title="A Super Chat / membership landed in this window; audio, voice and chat rate were down-weighted">paid suppressed</span>}
          {clip?.kind === 'premium' && clip.needs_review && <span className="badge premium">premium · review</span>}
        </div>
        <span className="small muted">
          {fmtTime(m.event_ts)} · {offsetLabel} · score <b>{m.score.toFixed(1)}</b>
        </span>
      </div>

      {clip ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          key={clip.id}
          src={`/api/media?key=${encodeURIComponent(clip.r2_key)}`}
          poster={clip.thumb_key ? `/api/media?key=${encodeURIComponent(clip.thumb_key)}` : undefined}
          controls
          preload="metadata"
          playsInline
        />
      ) : (
        <div className="placeholder">{m.status === 'failed' ? 'render failed' : 'rendering fast clip…'}</div>
      )}

      <BreakdownBar breakdown={m.breakdown} />
      <div className="small">
        {(m.label || m.vision_label) && <b>{m.label ?? m.vision_label}</b>}
        {m.vision_label && m.label && <span className="muted"> · vision: {m.vision_label}</span>}
      </div>
      {m.transcript && <div className="transcript">“{m.transcript}”</div>}

      {titles.length > 0 && (
        <div className="titles">
          {titles.map((t, i) => (
            <div key={i} className={`title-opt ${ui.editedTitle == null && ui.titleIndex === i ? 'on' : ''}`} onClick={() => onUi({ titleIndex: i, editedTitle: null })}>
              <kbd>{i + 1}</kbd>
              <span>{t}</span>
            </div>
          ))}
          <input
            data-title-input
            placeholder="Edit title (E)"
            value={ui.editedTitle ?? ''}
            onChange={(e) => onUi({ editedTitle: e.target.value || null })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                (e.target as HTMLInputElement).blur();
                if (ui.editedTitle) onAction('title', { title: ui.editedTitle });
              }
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
        </div>
      )}

      <div className="trim">
        <span className="muted">start</span>
        <div className="row">
          <button className="btn" onClick={() => onUi({ trimStart: Math.max(-5, ui.trimStart - 1) })}>−1s</button>
          <button className="btn" onClick={() => onUi({ trimStart: Math.min(5, ui.trimStart + 1) })}>+1s</button>
          <span className="small">{ui.trimStart > 0 ? '+' : ''}{ui.trimStart}s</span>
        </div>
        <span className="muted">end</span>
        <div className="row">
          <button className="btn" onClick={() => onUi({ trimEnd: Math.max(-5, ui.trimEnd - 1) })}>−1s</button>
          <button className="btn" onClick={() => onUi({ trimEnd: Math.min(5, ui.trimEnd + 1) })}>+1s</button>
          <span className="small">{ui.trimEnd > 0 ? '+' : ''}{ui.trimEnd}s</span>
        </div>
      </div>
      <div className="row">
        <button className="btn ok" disabled={!clip || busy || done} onClick={() => onAction('approve', chosen ? { title: chosen } : {})}>
          Approve <kbd>A</kbd>
        </button>
        <button className="btn bad" disabled={busy || done} onClick={() => onAction('reject')}>
          Reject <kbd>R</kbd>
        </button>
        <button
          className="btn"
          disabled={(ui.trimStart === 0 && ui.trimEnd === 0) || busy}
          onClick={() => onAction('trim', { startDeltaS: ui.trimStart, endDeltaS: ui.trimEnd })}
        >
          Trim → {Math.round(durS)}s <kbd>T</kbd>
        </button>
        <button className="btn" disabled={busy || m.status === 'premium'} onClick={() => onAction('premium')}>
          Premium <kbd>P</kbd>
        </button>
      </div>
      {m.reason && <div className="small muted">{m.reason}</div>}
      {m.chat_sample?.length > 0 && <div className="small muted">chat: {m.chat_sample.slice(0, 6).join(' · ')}</div>}
    </div>
  );
});
