import { useEffect, useState, useCallback } from 'react';

/**
 * Developer Event Viewer (Stage 1 only).
 *
 * Intentionally bare: a flat table of every stored event, newest first.
 * No charts, no timeline, no statistics. Exists purely to verify that the
 * capture stack is writing facts to SQLite. Will be replaced/hidden in later
 * stages — keep it dependency-free so it can be dropped without a trace.
 *
 * Polls `window.tracker.getToday()` every 3s. Polling (not push) keeps the
 * viewer self-contained and decoupled from the engine's write cadence.
 */
export function EventsPage() {
  const [events, setEvents] = useState<TrackerEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const rows = await window.tracker.getToday();
      setEvents(rows);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
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
          <div className="text-[13px] uppercase tracking-wide text-muted">Stage 1 — debug</div>
          <h1 className="text-[22px] font-semibold tracking-tight mt-1">Event Viewer</h1>
          <p className="text-[13.5px] text-muted mt-1">
            Every captured event for today, newest first. This page is for verifying the capture
            engine only — no analytics, no sessions, no classification.
          </p>
        </div>
      </section>

      {error && (
        <section className="card">
          <div className="card-section text-[13px]" style={{ color: 'var(--danger)' }}>
            Failed to load events: {error}
          </div>
        </section>
      )}

      <section className="card overflow-hidden">
        <div className="card-section">
          <div className="text-[12.5px] text-muted mb-3">Showing {events.length} event(s) today.</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)' }}>
                  {['Time', 'Duration', 'Watcher', 'App', 'Title', 'URL'].map((h) => (
                    <th
                      key={h}
                      className="text-left font-medium px-2 py-1.5 whitespace-nowrap"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {events.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center" style={{ color: 'var(--text-faint)' }}>
                      {loading ? 'Loading events…' : 'No events captured yet.'}
                    </td>
                  </tr>
                )}
                {events.map((e) => {
                  const started = new Date(e.startedAt);
                  const ended = new Date(e.endedAt);
                  const dur = humanDuration(ended.getTime() - started.getTime());
                  return (
                    <tr key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                        {fmtTime(started)}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap" style={{ color: 'var(--text-faint)' }}>
                        {dur}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">{e.watcher}</td>
                      <td className="px-2 py-1.5">{e.app ?? '—'}</td>
                      <td className="px-2 py-1.5">{e.title ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        {e.url ? (
                          <span className="text-[12px]" style={{ color: 'var(--accent)' }}>
                            {truncate(e.url, 60)}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function fmtTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}