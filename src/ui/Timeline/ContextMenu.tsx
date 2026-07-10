/**
 * Minimal, dependency-free context menu for a timeline session. Positioned
 * absolutely under the cursor; dismisses on Escape or an outside click. Add
 * Note opens a small inline input row in the menu.
 */
import { useEffect, useRef, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';

export interface MenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  session: VerifiedSessionDto;
  isToday: boolean;
  onRename: () => void;
  onSplit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onAddNote: (note: string) => void;
  onToggleOffline: (offline: boolean) => void;
  onCopyDetails: () => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  session,
  isToday,
  onRename,
  onSplit,
  onMerge,
  onDelete,
  onDuplicate,
  onAddNote,
  onToggleOffline,
  onCopyDetails,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState(session.note ?? '');

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (noteOpen) setNoteOpen(false);
        else onClose();
      }
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, noteOpen]);

  const isOffline = session.source === 'user';

  function commitNote() {
    onAddNote(noteDraft.trim());
    setNoteOpen(false);
    onClose();
  }

  const items: MenuItem[] = [
    { id: 'rename', label: 'Rename', onSelect: () => { onRename(); onClose(); }, disabled: !isToday },
    { id: 'split', label: 'Split', onSelect: () => { onSplit(); onClose(); }, disabled: !isToday },
    { id: 'merge', label: 'Merge with next', onSelect: () => { onMerge(); onClose(); }, disabled: !isToday },
    { id: 'duplicate', label: 'Duplicate', onSelect: () => { onDuplicate(); onClose(); }, disabled: !isToday },
    { id: 'note', label: noteOpen ? '✎ Add note…' : 'Add note', onSelect: () => setNoteOpen((v) => !v), disabled: !isToday },
    { id: 'offline', label: isOffline ? 'Convert to generated' : 'Convert Offline', onSelect: () => { onToggleOffline(!isOffline); onClose(); }, disabled: !isToday },
    { id: 'ai', label: 'Future AI Explain', onSelect: onClose, disabled: true },
    { id: 'copy', label: 'Copy details', onSelect: () => { onCopyDetails(); onClose(); } },
    { id: 'delete', label: 'Delete', onSelect: () => { onDelete(); onClose(); }, disabled: !isToday, danger: true },
  ];

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: Math.min(x, window.innerWidth - 190),
        top: Math.min(y, window.innerHeight - (items.length + 2) * 32),
        zIndex: 1000,
        minWidth: 180,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        padding: '4px',
      }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          role="menuitem"
          disabled={it.disabled}
          onClick={(e) => { e.stopPropagation(); if (!it.disabled) it.onSelect(); }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            border: 'none',
            background: 'transparent',
            color: it.disabled ? 'var(--text-faint)' : it.danger ? 'var(--danger)' : 'var(--text)',
            cursor: it.disabled ? 'default' : 'pointer',
            fontSize: '13px',
            transition: 'background var(--dur-fast) var(--ease-out)',
          }}
          onMouseEnter={(e) => { if (!it.disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
        >
          {it.label}
        </button>
      ))}

      {noteOpen && (
        <div style={{ padding: '6px 8px', display: 'flex', gap: 4, alignItems: 'center' }}>
          <input
            autoFocus
            placeholder="Note…"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onKeyUp={(e) => { if (e.key === 'Enter') commitNote(); }}
            onClick={(e) => e.stopPropagation()}
            style={{
              flex: 1,
              padding: '4px 6px',
              background: 'var(--bg)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text)',
              fontSize: '12.5px',
              outline: 'none',
            }}
          />
          <button
            onClick={(e) => { e.stopPropagation(); commitNote(); }}
            style={{ padding: '3px 8px', fontSize: '12px', color: 'var(--accent)', cursor: 'pointer' }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
