'use client';
import { useState } from 'react';

/** Human review gate for compilations: deliver after watching. */
export function DeliverButton({ clipId }: { clipId: string }) {
  const [state, setState] = useState<string | null>(null);
  return (
    <span className="row">
      <button
        className="btn ok"
        disabled={!!state}
        onClick={async () => {
          setState('queueing…');
          const res = await fetch('/api/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clipId, action: 'approve' }),
          });
          setState(res.ok ? 'approved — delivering' : 'failed');
        }}
      >
        Approve &amp; deliver
      </button>
      {state && <span className="small muted">{state}</span>}
    </span>
  );
}
