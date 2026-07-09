/**
 * Friendly empty state for the Day View timeline. Shown when a day has no
 * sessions. Uses a soft calendar glyph and a muted message — never an empty
 * grid. Does not block interaction (the canvas remains scrollable so the user
 * can still see the day's hours).
 */
import { memo } from 'react';
import { RULER_WIDTH } from './timelineUtils';

interface EmptyStateProps {
  isToday: boolean;
}

export const EmptyState = memo(function EmptyState({ isToday }: EmptyStateProps) {
  return (
    <div
      style={{
        position: 'absolute',
        left: RULER_WIDTH,
        right: 0,
        top: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        padding: 20,
        textAlign: 'center',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-faint)',
          fontSize: 20,
          lineHeight: 1,
        }}
        aria-hidden
      >
        ◔
      </div>
      <div style={{ fontSize: '14px', color: 'var(--text)' }}>
        {isToday ? 'No activity tracked yet' : 'No activity for this day'}
      </div>
      <div style={{ fontSize: '12.5px', color: 'var(--text-faint)', maxWidth: 280 }}>
        {isToday
          ? 'Switch windows on your computer and Reflect will start mapping your day here.'
          : 'Pick another day, or jump back to today to see live tracking.'}
      </div>
    </div>
  );
});