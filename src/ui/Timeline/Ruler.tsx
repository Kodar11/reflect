import { memo } from 'react';
import { DAY_PX_PER_HOUR, RULER_WIDTH } from './timelineUtils';

interface RulerProps {
  /** Full 24-hour canvas height. */
  height: number;
}

export const Ruler = memo(function Ruler({ height }: RulerProps) {
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
              marginRight: 8,
              flexShrink: 0,
            }}
          />
          {!t.minor && (
            <span
              style={{
                fontSize: '10.5px',
                color: 'var(--text)',
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                opacity: 0.72,
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
