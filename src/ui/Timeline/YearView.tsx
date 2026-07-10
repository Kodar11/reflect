import { useMemo } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { fmtDuration, startOfDay } from './timelineUtils';

interface YearViewProps {
  baseDay: Date;
  sessions: VerifiedSessionDto[];
  onDrillDown: (monthDate: Date) => void;
}

export function YearView({ baseDay, sessions, onDrillDown }: YearViewProps) {
  const currentYear = baseDay.getFullYear();

  // Aggregate stats per day
  const dayStatsMap = useMemo(() => {
    const map = new Map<string, { duration: number; count: number; longest: number }>();
    for (const s of sessions) {
      const dayKey = new Date(s.startedAt).toDateString();
      let stats = map.get(dayKey);
      if (!stats) {
        stats = { duration: 0, count: 0, longest: 0 };
        map.set(dayKey, stats);
      }
      stats.duration += s.duration;
      stats.count += 1;
      stats.longest = Math.max(stats.longest, s.duration);
    }
    return map;
  }, [sessions]);

  // Construct a grid representing weeks (columns) and days (rows)
  // To align, we find the Monday of the week containing Jan 1st of the currentYear.
  const gridWeeks = useMemo(() => {
    const jan1 = new Date(currentYear, 0, 1);
    const dayOfWeek = jan1.getDay(); // 0 is Sunday, 1 is Monday, etc.
    const diff = jan1.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const startMonday = new Date(jan1.setDate(diff));

    const weeks: Date[][] = [];
    // We render 53 weeks to cover the full year
    for (let w = 0; w < 53; w++) {
      const weekDays: Date[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(startMonday);
        date.setDate(startMonday.getDate() + w * 7 + d);
        weekDays.push(startOfDay(date));
      }
      weeks.push(weekDays);
    }
    return weeks;
  }, [currentYear]);

  // Determine month positions to show headers aligned to the columns
  const monthLabels = useMemo(() => {
    const labels: { label: string; colIdx: number }[] = [];
    let lastMonth = -1;

    gridWeeks.forEach((week, colIdx) => {
      const firstDayOfWeek = week[0];
      const m = firstDayOfWeek.getMonth();
      if (m !== lastMonth && firstDayOfWeek.getFullYear() === currentYear) {
        labels.push({
          label: firstDayOfWeek.toLocaleString(undefined, { month: 'short' }),
          colIdx,
        });
        lastMonth = m;
      }
    });
    return labels;
  }, [gridWeeks, currentYear]);

  const getCellColor = (durMs: number) => {
    if (durMs === 0) return 'var(--bg-secondary)';
    const hours = durMs / (3600 * 1000);
    if (hours < 1) return 'rgba(35, 130, 226, 0.18)';
    if (hours < 3) return 'rgba(35, 130, 226, 0.42)';
    if (hours < 6) return 'rgba(35, 130, 226, 0.72)';
    return 'var(--accent)';
  };

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
      }}
    >
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: '18px', fontWeight: 800, color: 'var(--text)' }}>Tracked Time Heatmap — {currentYear}</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: 2 }}>
          GitHub-style contribution tracker mapping total work hours recorded. Click any cell to jump to its Month View.
        </p>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 10,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 24,
          overflowX: 'auto',
          alignSelf: 'flex-start',
        }}
      >
        {/* Row Weekday labels */}
        <div
          style={{
            display: 'grid',
            gridTemplateRows: 'repeat(7, 12px)',
            gap: 3,
            fontSize: '9px',
            color: 'var(--text-faint)',
            fontWeight: 700,
            marginTop: 20, // offset below month labels row
            width: 24,
          }}
        >
          <div>Mon</div>
          <div style={{ visibility: 'hidden' }}>Tue</div>
          <div>Wed</div>
          <div style={{ visibility: 'hidden' }}>Thu</div>
          <div>Fri</div>
          <div style={{ visibility: 'hidden' }}>Sat</div>
          <div style={{ visibility: 'hidden' }}>Sun</div>
        </div>

        {/* Heatmap Area: Month labels + Cell columns */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {/* Month labels header */}
          <div style={{ position: 'relative', height: 14, fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>
            {monthLabels.map((lbl, idx) => (
              <span
                key={idx}
                style={{
                  position: 'absolute',
                  left: lbl.colIdx * 15,
                  whiteSpace: 'nowrap',
                }}
              >
                {lbl.label}
              </span>
            ))}
          </div>

          {/* Grid columns */}
          <div style={{ display: 'flex', gap: 3 }}>
            {gridWeeks.map((week, colIdx) => (
              <div key={colIdx} style={{ display: 'grid', gridTemplateRows: 'repeat(7, 12px)', gap: 3 }}>
                {week.map((cellDate, rowIdx) => {
                  const isCurrentYear = cellDate.getFullYear() === currentYear;
                  const stats = dayStatsMap.get(cellDate.toDateString()) ?? { duration: 0, count: 0, longest: 0 };
                  const color = isCurrentYear ? getCellColor(stats.duration) : 'transparent';

                  const tooltip = isCurrentYear
                    ? `${cellDate.toDateString()}\nTracked: ${fmtDuration(stats.duration)}\nSessions: ${stats.count}\nLongest Session: ${fmtDuration(stats.longest)}`
                    : '';

                  return (
                    <div
                      key={rowIdx}
                      onClick={() => { if (isCurrentYear) onDrillDown(cellDate); }}
                      title={tooltip}
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        background: color,
                        border: isCurrentYear ? '1px solid rgba(0, 0, 0, 0.05)' : 'none',
                        cursor: isCurrentYear ? 'pointer' : 'default',
                        transition: 'transform 80ms ease',
                      }}
                      onMouseEnter={(e) => {
                        if (isCurrentYear) {
                          (e.currentTarget as HTMLElement).style.transform = 'scale(1.22)';
                          (e.currentTarget as HTMLElement).style.zIndex = '10';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (isCurrentYear) {
                          (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
                          (e.currentTarget as HTMLElement).style.zIndex = '1';
                        }
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Heatmap Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: 'var(--text-faint)', marginTop: 16, alignSelf: 'flex-start' }}>
        <span>Less</span>
        <div style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--bg-secondary)' }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(35, 130, 226, 0.18)' }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(35, 130, 226, 0.42)' }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: 'rgba(35, 130, 226, 0.72)' }} />
        <div style={{ width: 10, height: 10, borderRadius: 2, background: 'var(--accent)' }} />
        <span>More</span>
      </div>
    </div>
  );
}
