import { useMemo } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { fmtDuration, fmtHm } from './timelineUtils';
import { Layers, Clock, Calendar, Activity, Sparkles } from 'lucide-react';

interface CustomViewProps {
  sessions: VerifiedSessionDto[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function CustomView({ sessions, selectedId, onSelect }: CustomViewProps) {
  // Aggregate stats
  const stats = useMemo(() => {
    const total = sessions.reduce((acc, s) => acc + s.duration, 0);
    const count = sessions.length;

    let longest: VerifiedSessionDto | null = null;
    for (const s of sessions) {
      if (!longest || s.duration > longest.duration) {
        longest = s;
      }
    }

    const distinctDays = new Set<string>();
    for (const s of sessions) {
      distinctDays.add(new Date(s.startedAt).toDateString());
    }
    const activeDays = Math.max(1, distinctDays.size);
    const dailyAverage = total / activeDays;

    return {
      total,
      count,
      dailyAverage,
      longest,
    };
  }, [sessions]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
        background: 'var(--bg)',
        overflow: 'hidden',
        padding: '24px',
        boxSizing: 'border-box',
        gap: 20,
      }}
    >
      <div>
        <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text)' }}>Custom Range Browser</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: 2 }}>
          Browse tracked details and inspect session notes for your selected date range. Click any row to inspect details.
        </p>
      </div>

      {/* Metrics Dashboard Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Clock size={16} />
          </div>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700 }}>Tracked Time</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{fmtDuration(stats.total)}</div>
          </div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Layers size={16} />
          </div>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700 }}>Total Sessions</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{stats.count}</div>
          </div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Calendar size={16} />
          </div>
          <div>
            <div style={{ fontSize: '10px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700 }}>Daily Average</div>
            <div style={{ fontSize: '16px', fontWeight: 800, color: 'var(--text)', marginTop: 2 }}>{fmtDuration(stats.dailyAverage)}</div>
          </div>
        </div>

        <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: '50%', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Sparkles size={16} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '10px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700 }}>Longest Session</div>
            <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {stats.longest ? stats.longest.title || 'Untitled' : '—'}
            </div>
          </div>
        </div>
      </div>

      {/* Flat sessions browser list */}
      <div className="card flex-1 overflow-hidden flex flex-col">
        <div className="card-section border-b border-default bg-secondary py-3">
          <span style={{ fontSize: '12.5px', color: 'var(--text-muted)', fontWeight: 600 }}>
            Chronological Sessions ({sessions.length})
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sessions.length === 0 ? (
            <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-faint)' }}>
              <Layers size={32} style={{ margin: '0 auto 8px', opacity: 0.5 }} />
              <div>No sessions recorded in this date range.</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {sessions.map((s) => {
                const isSelected = selectedId === s.id;
                const dateLabel = new Date(s.startedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                });

                return (
                  <div
                    key={s.id}
                    onClick={() => onSelect(s.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 20px',
                      borderBottom: '1px solid var(--border)',
                      cursor: 'pointer',
                      background: isSelected ? 'var(--bg-active)' : 'transparent',
                      transition: 'background var(--dur-fast) ease',
                    }}
                    onMouseEnter={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent';
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: 16 }}>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-muted)', minWidth: 50 }}>
                        {dateLabel}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <span style={{ fontSize: '13.5px', fontWeight: 700, color: 'var(--text)' }}>
                          {s.title || <em style={{ color: 'var(--text-faint)', fontWeight: 400 }}>untitled</em>}
                        </span>
                        {s.note && (
                          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {s.note}
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 16, flexShrink: 0 }}>
                      <span style={{ fontSize: '11.5px', color: 'var(--text-faint)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                        {fmtHm(new Date(s.startedAt))} – {fmtHm(new Date(s.endedAt))}
                      </span>
                      <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', minWidth: 60, textAlign: 'right' }}>
                        {fmtDuration(s.duration)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
