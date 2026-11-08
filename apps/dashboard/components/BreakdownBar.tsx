import { type BreakdownEntry, SIGNAL_COLORS, SIGNAL_LABELS } from '@/lib/types';

/** The "why": each signal's positive contribution to the moment's peak score. */
export function BreakdownBar({ breakdown }: { breakdown: Record<string, BreakdownEntry> }) {
  const entries = Object.entries(breakdown ?? {}).filter(([, b]) => b && b.contribution > 0);
  const total = entries.reduce((a, [, b]) => a + b.contribution, 0) || 1;
  return (
    <div>
      <div className="bar" title="signal contributions at the peak second">
        {entries.map(([k, b]) => (
          <span
            key={k}
            style={{
              width: `${(b.contribution / total) * 100}%`,
              background: SIGNAL_COLORS[k] ?? '#888',
              opacity: b.suppressed ? 0.4 : 1,
            }}
          />
        ))}
      </div>
      <div className="legend" style={{ marginTop: 4 }}>
        {entries
          .sort((a, b) => b[1].contribution - a[1].contribution)
          .map(([k, b]) => (
            <span key={k}>
              <i style={{ background: SIGNAL_COLORS[k] ?? '#888' }} />
              {SIGNAL_LABELS[k] ?? k} {k === 'vision_event' ? `${Math.round(b.z * 100)}%` : `z${b.z.toFixed(1)}`}
              {b.suppressed ? ' (suppressed)' : ''}
            </span>
          ))}
      </div>
    </div>
  );
}
