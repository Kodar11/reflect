import { useEffect, useMemo, useState } from 'react';
import { Clock, Calendar, Target, AlertOctagon, Pause, ArrowRight } from 'lucide-react';
import type { UseFocusResult, FocusSessionDto } from './useFocus';

interface RecentSessionsProps {
  focus: UseFocusResult;
  initialSessionId?: string | null;
  onViewInTimeline?: (isoDate: string) => void;
}

export function RecentSessions({ focus, initialSessionId, onViewInTimeline }: RecentSessionsProps) {
  const [sessions, setSessions] = useState<FocusSessionDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSessionId ?? null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    focus.getHistory(10).then((list) => {
      if (cancelled) return;
      setSessions(list);
      if (initialSessionId && list.some((s) => s.id === initialSessionId)) {
        setSelectedId(initialSessionId);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [focus, focus.activeSession?.session.id]);

  const selected = useMemo(() => sessions.find((s) => s.id === selectedId) ?? null, [sessions, selectedId]);

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Clock size={16} style={{ color: 'var(--accent)' }} />
          <h2 className="text-[16px] font-bold">Recent Sessions</h2>
        </div>
        <span className="text-[12px] text-muted">{sessions.length} session{sessions.length === 1 ? '' : 's'}</span>
      </div>

      {loading && sessions.length === 0 && (
        <div className="text-[13px] text-muted py-8 text-center">Loading...</div>
      )}

      {!loading && sessions.length === 0 && (
        <div className="text-[13px] text-muted py-6 text-center bg-secondary rounded-lg border border-default border-dashed">
          No sessions yet. Start your first focus session above.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            className="text-left card p-4 transition-colors border border-default hover:bg-hover"
            style={{
              background: selectedId === s.id ? 'var(--accent-soft)' : 'var(--bg)',
              borderColor: selectedId === s.id ? 'var(--accent)' : 'var(--border)',
            }}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="font-semibold text-[14px] text-default truncate">{s.task}</div>
                <div className="text-[12px] text-muted mt-0.5">
                  {formatDate(s.startedAt)} · {formatDuration(s.elapsedMs)}
                </div>
              </div>
              <div className="text-[11px] font-bold uppercase tracking-wide shrink-0" style={{ color: stateColor(s.state) }}>
                {s.state}
              </div>
            </div>
          </button>
        ))}
      </div>

      {selected && (
        <SessionDrawer
          focus={focus}
          session={selected}
          onClose={() => setSelectedId(null)}
          onViewInTimeline={onViewInTimeline}
        />
      )}
    </section>
  );
}

function SessionDrawer({
  focus,
  session,
  onClose,
  onViewInTimeline,
}: {
  focus: UseFocusResult;
  session: FocusSessionDto;
  onClose: () => void;
  onViewInTimeline?: (isoDate: string) => void;
}) {
  const [summary, setSummary] = useState<Awaited<ReturnType<UseFocusResult['getSessionSummary']>> | null>(null);

  useEffect(() => {
    let cancelled = false;
    focus.getSessionSummary(session.id).then((s) => {
      if (!cancelled) setSummary(s);
    });
    return () => { cancelled = true; };
  }, [focus, session.id]);

  const start = session.startedAt ? new Date(session.startedAt) : null;
  const end = session.endedAt ? new Date(session.endedAt) : null;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md h-full bg-secondary border-l border-default shadow-lg p-5 space-y-5 overflow-y-auto animate-in slide-in-from-right">
        <div className="flex items-center justify-between">
          <button onClick={onClose} className="text-[12px] text-muted hover:text-default font-semibold">Close</button>
        </div>

        <div>
          <div className="text-[12px] font-bold uppercase tracking-wide text-accent mb-2">Focus Session</div>
          <div className="text-[18px] font-bold text-default leading-tight">{session.task}</div>
          <div className="text-[13px] text-muted mt-1">{session.profileId} · {session.mode === 'countdown' ? 'Countdown' : 'Stopwatch'}</div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <MetricCard icon={<Clock size={14} />} label="Elapsed" value={formatDuration(session.elapsedMs)} />
          {session.plannedDurationMinutes !== null && (
            <MetricCard icon={<Calendar size={14} />} label="Planned" value={`${session.plannedDurationMinutes} min`} />
          )}
          {summary && (
            <MetricCard icon={<AlertOctagon size={14} />} label="Blocked" value={String(summary.blockedAttemptCount)} />
          )}
          {summary && (
            <MetricCard icon={<Pause size={14} />} label="Pauses" value={String(summary.interruptionCount)} />
          )}
        </div>

        {start && (
          <div className="text-[12px] text-muted">
            <span className="font-semibold text-default">{start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            {end && <span> – {end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
            <span className="ml-2">{start.toLocaleDateString()}</span>
          </div>
        )}

        {session.notes && (
          <div className="bg-default border border-default rounded-lg p-3 text-[13px] text-muted">
            {session.notes}
          </div>
        )}

        <button
          onClick={() => {
            const day = session.startedAt ? session.startedAt.split('T')[0] : new Date().toISOString().split('T')[0];
            onViewInTimeline?.(day);
          }}
          className="w-full flex items-center justify-center gap-2 py-2 px-3 rounded-md border border-default bg-secondary text-[12px] font-semibold text-default hover:bg-hover transition-colors"
        >
          <ArrowRight size={14} />
          View in Timeline
        </button>
      </div>
    </div>
  );
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="bg-default border border-default rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-muted mb-1">
        {icon}
        {label}
      </div>
      <div className="text-[16px] font-extrabold text-default font-mono">{value}</div>
    </div>
  );
}

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const remM = m % 60;
  const remS = s % 60;
  if (h > 0) return `${h}h ${remM}m`;
  return `${m}m ${remS}s`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function stateColor(state: FocusSessionDto['state']): string {
  switch (state) {
    case 'completed': return 'var(--success)';
    case 'cancelled': return 'var(--danger)';
    case 'active': return 'var(--accent)';
    case 'paused': return 'var(--text-muted)';
    default: return 'var(--text-faint)';
  }
}
