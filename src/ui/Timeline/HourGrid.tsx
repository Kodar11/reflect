import { memo } from 'react';
import { DAY_PX_PER_HOUR, RULER_WIDTH } from './timelineUtils';

interface HourGridProps {
  height: number;
}

export const HourGrid = memo(function HourGrid({ height }: HourGridProps) {
  const hourStep = DAY_PX_PER_HOUR;
  const halfStep = DAY_PX_PER_HOUR / 2;

  return (
    <div
      style={{
        position: 'absolute',
        left: RULER_WIDTH,
        top: 0,
        right: 0,
        height,
        backgroundImage: `
          repeating-linear-gradient(to bottom, var(--timeline-hour-band) 0 ${hourStep}px, transparent ${hourStep}px ${hourStep * 2}px),
          repeating-linear-gradient(to bottom, var(--timeline-grid-major) 0 1px, transparent 1px ${hourStep}px),
          repeating-linear-gradient(to bottom, var(--timeline-grid-minor) 0 1px, transparent 1px ${halfStep}px)
        `,
        backgroundSize: `100% ${hourStep * 2}px, 100% ${hourStep}px, 100% ${halfStep}px`,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
});
