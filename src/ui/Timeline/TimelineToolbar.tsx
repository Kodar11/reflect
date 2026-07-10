import { ChevronLeft, ChevronRight, Plus, RotateCcw, RotateCw } from 'lucide-react';

interface TimelineToolbarProps {
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
}

export function TimelineToolbar({
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
}: TimelineToolbarProps) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 30,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        background: 'var(--bg)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 650, fontSize: '15px', minWidth: 74 }}>Timeline</span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', borderRadius: 8, padding: 3, background: 'var(--bg-secondary)' }}>
        <TBtn onClick={onPrevDay} title="Previous day" icon><ChevronLeft size={15} /></TBtn>
        <input
          type="date"
          onChange={(e) => { if (e.target.value) onPickDay(e.target.value); }}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '12.5px',
            padding: '2px 6px',
            outline: 'none',
            cursor: 'pointer',
            width: 112,
          }}
        />
        <span style={{ fontSize: '12.5px', color: 'var(--text)', minWidth: 104, textAlign: 'center', userSelect: 'none', fontWeight: 500 }}>
          {dayLabel}
        </span>
        <TBtn onClick={onNextDay} title="Next day" icon><ChevronRight size={15} /></TBtn>
        <TBtn onClick={onToday} disabled={isToday} title="Jump to today">Today</TBtn>
      </div>

      <div style={{ flex: 1 }} />

      <TBtn disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)" icon><RotateCcw size={14} /></TBtn>
      <TBtn disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)" icon><RotateCw size={14} /></TBtn>
      <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
      <TBtn onClick={onInsertOffline} title="Add offline session (Ctrl+I)"><Plus size={14} /> Offline</TBtn>

      <span style={{ marginLeft: 4, fontSize: '11px', color: 'var(--text-faint)' }}>
        {activeEdits > 0 ? `${activeEdits} edit${activeEdits === 1 ? '' : 's'}` : 'verified'}
      </span>
    </div>
  );
}

function TBtn({
  children,
  onClick,
  disabled,
  title,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  icon?: boolean;
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
        gap: 5,
        height: 28,
        minWidth: icon ? 28 : undefined,
        padding: icon ? '0 6px' : '0 10px',
        borderRadius: 6,
        border: '1px solid transparent',
        background: 'transparent',
        color: disabled ? 'var(--text-faint)' : 'var(--text-muted)',
        fontSize: '12.5px',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}
