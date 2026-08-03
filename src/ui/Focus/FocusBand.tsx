import { Target } from 'lucide-react';
import type { FocusSessionDto } from './useFocus';

interface FocusBandProps {
  session: FocusSessionDto;
  top: number;
  height: number;
  width: number;
  left: number;
  isActive: boolean;
  onOpenFocus: (id: string) => void;
}

export function FocusBand({ session, top, height, width, left, isActive, onOpenFocus }: FocusBandProps) {
  const displayEnd = session.endedAt ? new Date(session.endedAt) : new Date();
  const displayStart = session.startedAt ? new Date(session.startedAt) : displayEnd;
  const durationMs = displayEnd.getTime() - displayStart.getTime();
  const durationMin = Math.max(1, Math.round(durationMs / 60000));

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onOpenFocus(session.id);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top,
        left,
        width,
        height: Math.max(height, 24),
        background: isActive
          ? 'var(--accent-soft)'
          : 'var(--bg-tertiary)',
        border: `2px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-md)',
        zIndex: 1,
        overflow: 'hidden',
        cursor: 'pointer',
        opacity: isActive ? 1 : 0.65,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 6,
          left: 8,
          right: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          fontSize: '11px',
          fontWeight: 700,
          color: 'var(--accent)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <Target size={11} />
        <span>{session.task}</span>
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 6,
          left: 8,
          fontSize: '10px',
          color: 'var(--text-muted)',
          fontWeight: 600,
        }}
      >
        {durationMin} min · {session.mode === 'countdown' ? 'countdown' : 'stopwatch'}
      </div>
    </div>
  );
}
