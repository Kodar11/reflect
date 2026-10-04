import { memo } from 'react';
import { DAY_PX_PER_HOUR, RULER_WIDTH } from './timelineUtils';

interface RulerProps {
  /** Full 24-hour canvas height. */
  height: number;
  /** Vertical scale; finer ticks appear as it grows. */
  pxPerHour?: number;
}

export const Ruler = memo(function Ruler({ height, pxPerHour = DAY_PX_PER_HOUR }: RulerProps) {
  // Half-hour ticks at the base scale, quarter-hour ticks once there is room.
  const stepMin = pxPerHour >= DAY_PX_PER_HOUR * 4 ? 15 : 30;
  // Between-hour ticks are labelled only when the labels cannot crowd.
  const labelMinor = pxPerHour >= DAY_PX_PER_HOUR * 2;
  const visible: { top: number; label: string; minor: boolean }[] = [];

  for (let min = 0; min <= 24 * 60; min += stepMin) {
    const minor = min % 60 !== 0;
    const label = `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    visible.push({ top: (min / 60) * pxPerHour, label: minor && !labelMinor ? '' : label, minor });
  }

  return (
    <div
      style={{
        position: 'relative',
        width: RULER_WIDTH,
        height,
        borderRight: '1px solid var(--border)',
        background: 'var(--bg)',
        zIndex: 5,
        pointerEvents: 'none',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
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
            height: 0,
            overflow: 'visible',
          }}
        >
          <div
            style={{
              width: t.minor ? 6 : 12,
              height: 1,
              background: t.minor ? 'var(--border-strong)' : 'var(--text)',
              opacity: t.minor ? 0.28 : 0.48,
              marginRight: t.minor ? 14 : 8,
              flexShrink: 0,
            }}
          />
          {t.label && (
            <span
              style={{
                fontSize: t.minor ? '9.5px' : '10.5px',
                color: 'var(--text)',
                fontFamily: 'var(--font-sans)',
                fontWeight: t.minor ? 500 : 600,
                letterSpacing: '-0.02em',
                opacity: t.minor ? 0.42 : 0.72,
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
  );
});
