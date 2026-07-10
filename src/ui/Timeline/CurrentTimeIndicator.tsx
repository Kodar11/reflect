/**
 * Pulsing current-time indicator. Only meaningful when viewing "today" — the
 * parent controls visibility. Positioned absolutely by its Y offset.
 */
import { memo } from 'react';
import { RULER_WIDTH } from './timelineUtils';

interface CurrentTimeIndicatorProps {
  top: number;
  width: number;
}

export const CurrentTimeIndicator = memo(function CurrentTimeIndicator({ top, width }: CurrentTimeIndicatorProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: RULER_WIDTH,
        width,
        height: 2,
        background: 'var(--danger)',
        boxShadow: '0 0 0 1px var(--bg), 0 0 12px var(--danger-soft)',
        zIndex: 8,
        pointerEvents: 'none',
        transition: 'top 30s linear',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: -6,
          top: -4,
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--danger)',
          boxShadow: '0 0 0 3px var(--bg), 0 0 0 5px var(--danger-soft)',
        }}
      />
    </div>
  );
});
