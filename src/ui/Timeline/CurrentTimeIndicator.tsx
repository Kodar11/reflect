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
        zIndex: 8,
        pointerEvents: 'none',
        transition: 'top 30s linear',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: -5,
          top: -3,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: 'var(--danger)',
          boxShadow: '0 0 0 2px var(--bg)',
        }}
      />
    </div>
  );
});