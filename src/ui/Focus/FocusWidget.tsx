import { Play, Pause, Square, Target } from 'lucide-react';
import { useState } from 'react';
import { formatClock, type ActiveFocusSessionDto } from './useFocus';

interface FocusWidgetProps {
  session: ActiveFocusSessionDto;
  onPause: (reason?: string) => void;
  onResume: () => void;
  onStop: (state: 'completed' | 'cancelled') => void;
  minimized?: boolean;
  onToggleMinimize?: () => void;
}

const PAUSE_REASONS = ['Quick break', 'Phone call', 'Meeting', 'Distraction', 'Other'];

export function FocusWidget({ session, onPause, onResume, onStop, minimized, onToggleMinimize }: FocusWidgetProps) {
  const [showPauseMenu, setShowPauseMenu] = useState(false);
  const isOver = session.remainingMs !== null && session.remainingMs <= 0;
  const displayMs = isOver ? session.liveElapsedMs : (session.remainingMs ?? session.liveElapsedMs);
  const label = isOver ? 'Over' : session.remainingMs !== null ? 'Remaining' : 'Elapsed';
  const isRunning = session.isRunning;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 1000,
        width: minimized ? 'auto' : 280,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--accent)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-xl)',
        padding: minimized ? '10px 14px' : '16px 18px',
        display: 'flex',
        flexDirection: minimized ? 'row' : 'column',
        gap: minimized ? 10 : 12,
        animation: 'slideUp 180ms var(--ease-out)',
        cursor: minimized ? 'pointer' : 'default',
      }}
      onClick={minimized ? onToggleMinimize : undefined}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <div style={{
          width: 32,
          height: 32,
          borderRadius: '50%',
          background: 'var(--accent-soft)',
          color: 'var(--accent)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Target size={16} />
        </div>
        {!minimized && (
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {session.session.task}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 1 }}>
              {session.profile.name} · {isRunning ? 'Focusing' : 'Paused'}
            </div>
          </div>
        )}
        {minimized && (
          <div style={{ fontSize: '16px', fontWeight: 700, color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>
            {formatClock(displayMs)}
          </div>
        )}
      </div>

      {!minimized && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{ fontSize: '34px', fontWeight: 800, color: 'var(--text)', fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
              {formatClock(displayMs)}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              {label}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isRunning ? (
              <>
                <button
                  type="button"
                  onClick={() => setShowPauseMenu((v) => !v)}
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 6,
                    padding: '9px 0',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text)',
                    fontSize: '12.5px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <Pause size={14} /> Pause
                </button>
                {showPauseMenu && (
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 4 }}>
                    {PAUSE_REASONS.map((reason) => (
                      <button
                        key={reason}
                        type="button"
                        onClick={() => { onPause(reason); setShowPauseMenu(false); }}
                        style={{
                          textAlign: 'left',
                          padding: '7px 10px',
                          borderRadius: 'var(--radius-md)',
                          border: '1px solid var(--border)',
                          background: 'var(--bg)',
                          color: 'var(--text-muted)',
                          fontSize: '12px',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--accent-soft)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg)'; }}
                      >
                        {reason}
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={onResume}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '9px 0',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border)',
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Play size={14} /> Resume
              </button>
            )}
            <button
              type="button"
              onClick={() => onStop('completed')}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '9px 0',
                borderRadius: 'var(--radius-md)',
                border: 'none',
                background: 'var(--accent)',
                color: 'var(--accent-text)',
                fontSize: '12.5px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Square size={14} /> Stop
            </button>
          </div>

          <button
            type="button"
            onClick={onToggleMinimize}
            style={{
              alignSelf: 'center',
              fontSize: '11px',
              color: 'var(--text-faint)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Minimize
          </button>
        </>
      )}
    </div>
  );
}
