import { memo } from 'react';
import { DAY_PX_PER_HOUR } from './timelineUtils';

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
        left: 0,
        top: 0,
        right: 0,
        height,
        backgroundImage: `
          linear-gradient(to bottom, var(--timeline-hour-band) 0px, var(--timeline-hour-band) ${hourStep}px, transparent ${hourStep}px, transparent ${hourStep * 2}px),
          linear-gradient(to bottom, var(--timeline-grid-major) 1px, transparent 1px),
          linear-gradient(to bottom, var(--timeline-grid-minor) 1px, transparent 1px)
        `,
        backgroundSize: `100% ${hourStep * 2}px, 100% ${hourStep}px, 100% ${halfStep}px`,
        backgroundRepeat: 'repeat-y',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
});
