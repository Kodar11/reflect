/**
 * Background hour + half-hour grid lines for the Day View timeline. Purely
 * decorative (pointer-events: none). Hour lines are stronger (full
 * `--border`); half-hour guide lines are fainter.
 */
import { memo } from 'react';
import { DAY_PX_PER_HOUR, RULER_WIDTH } from './timelineUtils';

interface HourGridProps {
  /** Full 24-hour canvas height. */
  height: number;
}

export const HourGrid = memo(function HourGrid({ height }: HourGridProps) {
  const hours = 24;
  // Build two repeating-linear-gradient layers in one background for crisp,
  // inexpensive grid lines without 48 DOM nodes.
  const hourStep = DAY_PX_PER_HOUR;
  const halfStep = DAY_PX_PER_HOUR / 2;
  const background = `
    linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${hourStep}px),
    linear-gradient(to bottom, var(--border) 0 1px, transparent 1px ${halfStep}px)
  `;

  return (
    <div
      style={{
        position: 'absolute',
        left: RULER_WIDTH,
        top: 0,
        right: 0,
        height,
        backgroundImage: background,
        backgroundSize: `100% ${hourStep}px, 100% ${halfStep}px`,
        backgroundPosition: '0 0',
        // Make the half-hour layer faint by overlaying a subtle mask via opacity
        // on the secondary gradient only — emulate by stacking with a second div.
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      {/* Faint half-hour overlay: a single repeating line at half-hour, lighter. */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage: 'linear-gradient(to bottom, var(--border-strong) 0 0.5px, transparent 0.5px ' + halfStep + 'px)',
          backgroundSize: `100% ${halfStep}px`,
          opacity: 0.5,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
});