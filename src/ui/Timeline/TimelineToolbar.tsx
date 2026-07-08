/**
 * Sticky timeline toolbar: branding, undo/redo, insert-offline, edit-count
 * status, shortcut hints. All actions dispatch through the parent store;
 * disabled states mirror whether undo/redo have anything to act on.
 */
interface TimelineToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  activeEdits: number;
  onUndo: () => void;
  onRedo: () => void;
  onInsertOffline: () => void;
  onShowHelp: () => void;
}

export function TimelineToolbar({
  canUndo, canRedo, activeEdits, onUndo, onRedo, onInsertOffline, onShowHelp,
}: TimelineToolbarProps) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        background: 'var(--bg-secondary)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ fontWeight: 600, fontSize: '14px' }}>Timeline</span>
      <span style={{ color: 'var(--text-faint)', fontSize: '12px' }}>· verified day</span>

      <div style={{ flex: 1 }} />

      <Btn disabled={!canUndo} onClick={onUndo} title="Undo (Ctrl+Z)">↶ Undo</Btn>
      <Btn disabled={!canRedo} onClick={onRedo} title="Redo (Ctrl+Shift+Z)">↷ Redo</Btn>
      <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
      <Btn onClick={onInsertOffline} title="Insert offline activity (I)">+ Offline</Btn>
      <Btn onClick={onShowHelp} title="Keyboard shortcuts">?</Btn>

      <span style={{ marginLeft: 10, fontSize: '11px', color: 'var(--text-faint)' }}>
        {activeEdits > 0 ? `${activeEdits} edit${activeEdits === 1 ? '' : 's'}` : 'verified'}
      </span>
    </div>
  );
}

function Btn({ children, onClick, disabled, title }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: '3px 9px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        background: disabled ? 'transparent' : 'var(--bg)',
        color: disabled ? 'var(--text-faint)' : 'var(--text-muted)',
        fontSize: '12.5px',
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = disabled ? 'transparent' : 'var(--bg)'; }}
    >{children}</button>
  );
}