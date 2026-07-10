import { ChevronLeft, ChevronRight, Plus, RotateCcw, RotateCw, Calendar } from 'lucide-react';

export type TimelineView = 'day' | 'week' | 'month' | 'year' | 'custom';

interface TimelineToolbarProps {
  view: TimelineView;
  onViewChange: (view: TimelineView) => void;
  dayLabel: string;
  onPrevDay: () => void;
  onNextDay: () => void;
  onPickDay: (date: string) => void;
  onToday: () => void;
  isToday: boolean;
  canUndo: boolean;
  canRedo: boolean;
  activeEdits: number;
  onUndo: () => void;
  onRedo: () => void;
  onInsertOffline: () => void;
  // Custom View Range Props
  customStart: string;
  customEnd: string;
  onCustomStartChange: (date: string) => void;
  onCustomEndChange: (date: string) => void;
}

export function TimelineToolbar({
  view,
  onViewChange,
  dayLabel,
  onPrevDay,
  onNextDay,
  onPickDay,
  onToday,
  isToday,
  canUndo,
  canRedo,
  activeEdits,
  onUndo,
  onRedo,
  onInsertOffline,
  customStart,
  customEnd,
  onCustomStartChange,
  onCustomEndChange,
}: TimelineToolbarProps) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 24px',
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        gap: 12,
      }}
    >
      {/* Left section: Date Navigation or Custom Pickers */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        {view === 'custom' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '4px 10px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600 }}>Range:</span>
            <input
              type="date"
              value={customStart}
              aria-label="Start Date"
              onChange={(e) => { if (e.target.value) onCustomStartChange(e.target.value); }}
              style={{
                background: 'var(--bg)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '1px 6px',
                fontSize: '12px',
                outline: 'none',
              }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-faint)' }}>to</span>
            <input
              type="date"
              value={customEnd}
              aria-label="End Date"
              onChange={(e) => { if (e.target.value) onCustomEndChange(e.target.value); }}
              style={{
                background: 'var(--bg)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
                borderRadius: '4px',
                padding: '1px 6px',
                fontSize: '12px',
                outline: 'none',
              }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 2 }}>
            <TBtn onClick={onPrevDay} title={`Previous ${view}`} icon><ChevronLeft size={16} /></TBtn>
            
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', padding: '0 8px', gap: 6 }}>
              <Calendar size={13} style={{ color: 'var(--text-muted)' }} />
              <input
                type="date"
                aria-label="Choose Date"
                onChange={(e) => { if (e.target.value) onPickDay(e.target.value); }}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: '100%',
                  opacity: 0,
                  cursor: 'pointer',
                }}
              />
              <span style={{ fontSize: '13px', color: 'var(--text)', userSelect: 'none', fontWeight: 600, whiteSpace: 'nowrap' }}>
                {dayLabel}
              </span>
            </div>

            <TBtn onClick={onNextDay} title={`Next ${view}`} icon><ChevronRight size={16} /></TBtn>
          </div>
        )}

        {view !== 'custom' && (
          <TBtn onClick={onToday} disabled={isToday} title="Jump to today" style={{
            background: isToday ? 'transparent' : 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-md)',
            padding: '0 12px',
            fontWeight: 600,
          }}>
            Today
          </TBtn>
        )}
      </div>

      {/* Center section: View Toggle Tabs */}
      <div style={{ display: 'flex', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 2, flexShrink: 0 }}>
        {(['day', 'week', 'month', 'year', 'custom'] as TimelineView[]).map((v) => {
          const isActive = view === v;
          const label = v.charAt(0).toUpperCase() + v.slice(1);
          return (
            <TBtn
              key={v}
              onClick={() => onViewChange(v)}
              style={{
                background: isActive ? 'var(--bg)' : 'transparent',
                color: isActive ? 'var(--text)' : 'var(--text-muted)',
                fontWeight: isActive ? 600 : 500,
                borderRadius: 'var(--radius-sm)',
                boxShadow: isActive ? 'var(--shadow-sm)' : 'none',
                minWidth: 60,
              }}
            >
              {label}
            </TBtn>
          );
        })}
      </div>

      {/* Right section: Undo/Redo & Add Offline (Day & Week views only) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 200, justifyContent: 'flex-end', flexShrink: 0 }}>
        {(view === 'day' || view === 'week') ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 2 }}>
              <TBtn disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)" icon><RotateCcw size={14} /></TBtn>
              <TBtn disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)" icon><RotateCw size={14} /></TBtn>
            </div>

            <span style={{ width: 1, height: 16, background: 'var(--border)', margin: '0 2px' }} />

            <TBtn onClick={onInsertOffline} title="Add offline session (Ctrl+I)" style={{
              background: 'var(--accent)',
              color: 'var(--accent-text)',
              borderRadius: 'var(--radius-md)',
              padding: '0 14px',
              fontWeight: 650,
              boxShadow: 'var(--shadow-sm)',
            }}>
              <Plus size={14} /> Add Offline
            </TBtn>

            {activeEdits > 0 && (
              <span style={{ marginLeft: 6, fontSize: '11px', color: 'var(--text-faint)', fontWeight: 500, whiteSpace: 'nowrap' }}>
                {activeEdits} pending
              </span>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function TBtn({
  children,
  onClick,
  disabled,
  title,
  icon,
  style,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: 28,
        minWidth: icon ? 28 : undefined,
        padding: icon ? '0' : '0 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: disabled ? 'var(--text-faint)' : 'var(--text-muted)',
        fontSize: '12.5px',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)',
        ...style,
      }}
      onMouseEnter={(e) => { if (!disabled) { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; } }}
      onMouseLeave={(e) => {
        const bgVal = style?.background;
        (e.currentTarget as HTMLElement).style.background = typeof bgVal === 'string' ? bgVal : 'transparent';
      }}
    >
      {children}
    </button>
  );
}
