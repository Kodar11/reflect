import { memo } from 'react';

interface CurrentTimeIndicatorProps {
  top: number;
}

export const CurrentTimeIndicator = memo(function CurrentTimeIndicator({ top }: CurrentTimeIndicatorProps) {
  return (
    <div
      style={{
        position: 'absolute',
        top,
        left: 0,
        right: 0,
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
          left: -5,
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
