import { useEffect, useCallback } from 'react';

/**
 * Timeline keyboard shortcuts (Day View, single selection).
 *
 * Shortcuts avoid firing while the user is typing in an input/textarea.
 *
 *   Enter        → start rename on selected session
 *   Esc          → clear selection
 *   Delete       → delete selected session
 *   Ctrl+Z       → undo
 *   Ctrl+Shift+Z / Ctrl+Y → redo
 *   ↑ / ↓        → navigate to prev/next session
 *
 * Edits (rename/delete/etc.) only fire when `editable` is true (i.e. viewing
 * today), honoring the backend's today-only edit resolution.
 */
export interface TimelineKeyboardActions {
  editable: boolean;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onNavigate: (dir: -1 | 1) => void;
  onClearSelection: () => void;
}

export function useTimelineKeyboard(
  selectedId: string | null,
  actions: TimelineKeyboardActions,
) {
  const handler = useCallback((e: KeyboardEvent) => {
    if (typingInField()) return;

    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      actions.onUndo();
      return;
    }
    if (mod && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      actions.onRedo();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      actions.onClearSelection();
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      actions.onNavigate(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }

    if (!selectedId) return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (actions.editable) actions.onDelete(selectedId);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (actions.editable) actions.onRename(selectedId);
    }
  }, [selectedId, actions]);

  useEffect(() => {
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handler]);
}

function typingInField(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
