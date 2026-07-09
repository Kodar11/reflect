/**
 * Sticky Day View toolbar: day navigation (prev / date picker / next / Today),
 * undo/redo, and Add Offline. Compact chrome so the timeline workspace
 * dominates. No zoom controls (Day View only).
 */
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
        gap: 8,
        padding: '8px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 600, fontSize: '14px' }}>Timeline</span>

      {/* Day navigation */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 2 }}>
        <TBtn onClick={onPrevDay} title="Previous day">◀</TBtn>
        <input
          type="date"
          onChange={(e) => { if (e.target.value) onPickDay(e.target.value); }}
          style={{
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            fontSize: '12.5px',
            padding: '2px 4px',
            outline: 'none',
            cursor: 'pointer',
          }}
        />
        <span style={{ fontSize: '12px', color: 'var(--text-muted)', minWidth: 96, textAlign: 'center', userSelect: 'none' }}>
          {dayLabel}
        </span>
        <TBtn onClick={onNextDay} title="Next day">▶</TBtn>
        <TBtn onClick={onToday} disabled={isToday} title="Jump to today">Today</TBtn>
      </div>

      <div style={{ flex: 1 }} />

      <TBtn disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)">↶ Undo</TBtn>
      <TBtn disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</TBtn>
      <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
      <TBtn onClick={onInsertOffline} title="Add offline session (Ctrl+I)">+ Offline</TBtn>

      <span style={{ marginLeft: 8, fontSize: '11px', color: 'var(--text-faint)' }}>
        {activeEdits > 0 ? `${activeEdits} edit${activeEdits === 1 ? '' : 's'}` : 'verified'}
      </span>
    </div>
  );
}

function TBtn({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '3px 9px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid transparent',
        background: 'transparent',
        color: disabled ? 'var(--text-faint)' : 'var(--text-muted)',
        fontSize: '12.5px',
        cursor: disabled ? 'default' : 'pointer',
        transition: 'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
    >{children}</button>
  );
}