import { useMemo } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { fmtDuration, startOfDay } from './timelineUtils';

interface MonthViewProps {
  baseDay: Date;
  sessions: VerifiedSessionDto[];
  onDrillDown: (day: Date) => void;
}

export function MonthView({ baseDay, sessions, onDrillDown }: MonthViewProps) {
  const currentYear = baseDay.getFullYear();
  const currentMonth = baseDay.getMonth();

  // Create the Monday-start calendar days grid (35 or 42 cells)
  const gridCells = useMemo(() => {
    const firstDay = new Date(currentYear, currentMonth, 1);
    const lastDay = new Date(currentYear, currentMonth + 1, 0);

    let startDayOfWeek = firstDay.getDay(); // 0 is Sunday, 1 is Monday, etc.
    // Convert to Monday-start (0 = Mon, 1 = Tue, ..., 6 = Sun)
    startDayOfWeek = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;

    const cells: Date[] = [];
    // Prev Month Padding
    for (let i = startDayOfWeek; i > 0; i--) {
      cells.push(new Date(currentYear, currentMonth, 1 - i));
    }
    // Current Month
    for (let i = 1; i <= lastDay.getDate(); i++) {
      cells.push(new Date(currentYear, currentMonth, i));
    }
    // Next Month Padding
    const totalCells = cells.length <= 35 ? 35 : 42;
    const nextDays = totalCells - cells.length;
    for (let i = 1; i <= nextDays; i++) {
      cells.push(new Date(currentYear, currentMonth + 1, i));
    }
    return cells;
  }, [currentYear, currentMonth]);

  // Group sessions by day string
  const daySessionsMap = useMemo(() => {
    const map = new Map<string, VerifiedSessionDto[]>();
    for (const s of sessions) {
      const dayKey = new Date(s.startedAt).toDateString();
      let list = map.get(dayKey);
      if (!list) {
        list = [];
        map.set(dayKey, list);
      }
      list.push(s);
    }
    return map;
  }, [sessions]);

  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const now = new Date();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
        background: 'var(--bg)',
        overflow: 'hidden',
        padding: '12px 24px',
        boxSizing: 'border-box',
      }}
    >
      {/* Weekday headers row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          borderBottom: '1px solid var(--border)',
          paddingBottom: 8,
          marginBottom: 8,
          textAlign: 'center',
          fontWeight: 700,
          fontSize: '12px',
          color: 'var(--text-muted)',
        }}
      >
        {weekdays.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      {/* Grid of cells */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gridAutoRows: '1fr',
          flex: 1,
          gap: 8,
        }}
      >
        {gridCells.map((cellDate, idx) => {
          const isCurrentMonth = cellDate.getMonth() === currentMonth;
          const isToday = cellDate.toDateString() === now.toDateString();
          const daySessions = daySessionsMap.get(cellDate.toDateString()) ?? [];

          // Compute stats
          const totalTime = daySessions.reduce((acc, s) => acc + s.duration, 0);
          const topApps = getTopApps(daySessions);

          return (
            <div
              key={idx}
              onClick={() => onDrillDown(cellDate)}
              style={{
                background: isCurrentMonth ? 'var(--bg-secondary)' : 'rgba(var(--bg-secondary), 0.3)',
                border: isToday ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                borderRadius: 12,
                padding: '10px 12px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                cursor: 'pointer',
                opacity: isCurrentMonth ? 1 : 0.45,
                transition: 'transform var(--dur-fast) ease, border-color var(--dur-fast) ease, box-shadow var(--dur-fast) ease',
                boxShadow: isToday ? '0 0 10px rgba(35, 130, 226, 0.15)' : 'none',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)';
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)';
                (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.transform = 'translateY(0)';
                (e.currentTarget as HTMLElement).style.borderColor = isToday ? 'var(--accent)' : 'var(--border)';
                (e.currentTarget as HTMLElement).style.boxShadow = isToday ? '0 0 10px rgba(35, 130, 226, 0.15)' : 'none';
              }}
            >
              {/* Top Row: Date Label & Session Count */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 700,
                    color: isToday ? 'var(--accent)' : 'var(--text)',
                  }}
                >
                  {cellDate.getDate()}
                </span>
                {daySessions.length > 0 && (
                  <span
                    style={{
                      fontSize: '10.5px',
                      color: 'var(--text-muted)',
                      background: 'var(--bg)',
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      padding: '1px 5px',
                      fontWeight: 600,
                    }}
                  >
                    {daySessions.length} ses
                  </span>
                )}
              </div>

              {/* Middle Row: Duration Summary */}
              {totalTime > 0 ? (
                <div style={{ fontSize: '14px', fontWeight: 800, color: 'var(--text)', margin: '6px 0' }}>
                  {fmtDuration(totalTime)}
                </div>
              ) : (
                <div style={{ flex: 1 }} />
              )}

              {/* Bottom Row: Top Apps Badges */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, overflow: 'hidden', height: 20 }}>
                {topApps.map((app) => (
                  <span
                    key={app}
                    className="chip truncate"
                    style={{
                      fontSize: '9.5px',
                      padding: '1px 4px',
                      borderRadius: 6,
                      maxWidth: '100%',
                      background: 'var(--bg)',
                    }}
                  >
                    {app}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Extract top 2 apps/websites
function getTopApps(daySessions: VerifiedSessionDto[]): string[] {
  const counts = new Map<string, number>();
  for (const s of daySessions) {
    for (const app of s.appsUsed) {
      counts.set(app, (counts.get(app) ?? 0) + 1);
    }
    for (const tab of s.browserTabs) {
      let host = tab;
      try {
        if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
        const url = new URL(host);
        host = url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname;
      } catch {
        const match = tab.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
        if (match && match[1]) host = match[1];
      }
      if (host) counts.set(host, (counts.get(host) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map((x) => x[0]);
}
