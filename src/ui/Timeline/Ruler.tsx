/**
 * Vertical time ruler for the Day View timeline.
 *
 * Pinned to the left edge as a sticky column: it has its own vertical scroll
 * offset that mirrors the canvas, so the hour labels stay visible while the
 * session blocks scroll past. Uses a single density (DAY_PX_PER_HOUR).
 *
 * Hour labels (00–24) at the major ticks; a short minor tick at each half hour.
 * No zoom dial — Day View only.
 */
import { memo } from 'react';
import { DAY_PX_PER_HOUR, RULER_WIDTH } from './timelineUtils';

interface RulerProps {
  /** Current scroll offset of the canvas, in px from the top of the day. */
  scrollTop: number;
  /** Visible viewport height (used to size the sticky column). */
  viewportHeight: number;
  /** Full 24-hour canvas height. */
  height: number;
}

export const Ruler = memo(function Ruler({ scrollTop, viewportHeight, height }: RulerProps) {
  const hours = 25; // 00:00 .. 24:00
  const visible: { top: number; label: string; minor: boolean }[] = [];

  for (let h = 0; h < hours; h++) {
    const top = h * DAY_PX_PER_HOUR;
    visible.push({ top, label: `${String(h).padStart(2, '0')}:00`, minor: false });
    // Half-hour minor tick (only between hours, not after 24:00).
    if (h < 24) {
      visible.push({ top: top + DAY_PX_PER_HOUR / 2, label: '', minor: true });
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: RULER_WIDTH,
        height,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        zIndex: 5,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {/* Inner wrapper translates the ticks opposite to the canvas scroll so
          the visible portion of the ruler always aligns with the grid. */}
      <div style={{ position: 'absolute', left: 0, top: -scrollTop, width: '100%', height }}>
        {visible.map((t, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              top: t.top,
              left: 0,
              right: 0,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <div
              style={{
                width: t.minor ? 5 : 9,
                height: 1,
                background: t.minor ? 'var(--border-strong)' : 'var(--text-muted)',
                marginRight: 4,
                flexShrink: 0,
              }}
            />
            {!t.minor && (
              <span
                style={{
                  fontSize: '10.5px',
                  color: 'var(--text-muted)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  transform: 'translateY(-50%)',
                  lineHeight: 1,
                }}
              >
                {t.label}
              </span>
            )}
          </div>
        ))}
      </div>
      {/* Clip mask so the sticky column only paints its visible height. The
          outer div's height already bounds painting; this is a no-op guard. */}
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1, height: viewportHeight, pointerEvents: 'none' }} />
    </div>
  );
});