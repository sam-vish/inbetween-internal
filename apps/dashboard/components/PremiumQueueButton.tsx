'use client';
import { useState } from 'react';

export function PremiumQueueButton({ momentIds }: { momentIds: string[] }) {
  const [state, setState] = useState<string | null>(null);
  if (!momentIds.length) return <p className="small muted">Nothing to queue.</p>;
  return (
    <div className="row">
      <button
        className="btn"
        disabled={!!state}
        onClick={async () => {
          setState('queueing…');
          const results = await Promise.all(
            momentIds.map((momentId) =>
              fetch('/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ momentId, action: 'premium' }) }),
            ),
          );
          setState(`${results.filter((r) => r.ok).length}/${momentIds.length} queued for the premium lane`);
        }}
      >
        Queue these {momentIds.length} for premium
      </button>
      {state && <span className="small muted">{state}</span>}
    </div>
  );
}
