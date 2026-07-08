import { useEffect, useState, useCallback } from 'react';

/**
 * Session Viewer (Stage 2 developer UI).
 *
 * Not the final UX — a flat debug view of derived sessions, newest first.
 * Mirrors the Stage 1 Event Viewer's style so the two dev tabs read alike.
 * Polls `window.session.getToday()` every 3s; sessions are re-derived in main
 * from raw events on each call (never persisted).
 *
 * No timeline, no editing, no charts. Replaced by the real sessions UI in a
 * later stage; kept dependency-free so it can be dropped without a trace.
 */
export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionDto[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await window.session.getToday();
      setSessions(rows);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="space-y-6">
      <section className="card">
        <div className="card-section">
          <div className="text-[13px] uppercase tracking-wide text-muted">Stage 2 — debug</div>
          <h1 className="text-[22px] font-semibold tracking-tight mt-1">Session Viewer</h1>
          <p className="text-[13.5px] text-muted mt-1">
            Derived sessions for today, newest first. Sessions reconstruct what you were doing and
            are generated on demand from raw events — nothing is persisted.
          </p>
        </div>
      </section>

      {error && (
        <section className="card">
          <div className="card-section text-[13px]" style={{ color: 'var(--danger)' }}>
            Failed to load sessions: {error}
          </div>
        </section>
      )}

      <section className="card overflow-hidden">
        <div className="card-section">
          <div className="text-[12.5px] text-muted mb-3">
            {sessions.length} session(s) today.
          </div>
          <div className="space-y-3">
            {sessions.length === 0 && (
              <div className="px-2 py-6 text-center text-[13px]" style={{ color: 'var(--text-faint)' }}>
                No sessions yet. Switch windows to start capturing.
              </div>
            )}
            {sessions.map((s) => (
              <SessionRow key={s.id} s={s} />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function SessionRow({ s }: { s: SessionDto }) {
  const start = new Date(s.startedAt);
  const end = new Date(s.endedAt);
  return (
    <div
      className="rounded-md p-3"
      style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-[14px] font-medium">
          {fmtTime(start)} – {fmtTime(end)}
        </div>
        <div className="text-[12.5px]" style={{ color: 'var(--text-muted)' }}>
          {humanDuration(s.duration)}
          {s.activeDuration > 0 && s.activeDuration < s.duration && (
            <span style={{ color: 'var(--text-faint)' }}> · {humanDuration(s.activeDuration)} active</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-[12.5px]">
        <Field label="Primary app" value={s.primaryApp} />
        <Field label="Primary browser" value={s.primaryBrowser} />
        <Field label="Primary title" value={s.primaryTitle} truncate />
        <Field label="Primary URL" value={s.primaryUrl} truncate />
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Apps: </span>
          <span>{s.appsUsed.length ? s.appsUsed.join(', ') : '—'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Tabs: </span>
          <span>{s.browserTabs.length ? s.browserTabs.length : '—'}</span>
        </div>
        <div>
          <span style={{ color: 'var(--text-muted)' }}>Events: </span>
          <span>{s.eventCount}</span>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, truncate }: { label: string; value: string | null; truncate?: boolean }) {
  return (
    <div className="min-w-0">
      <span style={{ color: 'var(--text-muted)' }}>{label}: </span>
      <span>
        {value ? (truncate ? truncateStr(value, 60) : value) : '—'}
      </span>
    </div>
  );
}

function fmtTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function humanDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function truncateStr(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}