/**
 * Minimal, dependency-free context menu. Positioned absolutely under the
 * cursor, dismisses on Escape or an outside click. Renders `items` as a
 * vertical list with dividers; disabled items render greyed and inert.
 *
 * Built custom (no react-menu dependency) to keep the bundle slim and the
 * keyboard behavior under our direct control. Future shortcuts attach here.
 */
import { useEffect, useRef } from 'react';

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
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 1000,
        minWidth: 180,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        padding: '4px',
        fontSize: '13px',
        color: 'var(--text)',
      }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          role="menuitem"
          disabled={it.disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (it.disabled) return;
            it.onSelect();
            onClose();
          }}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'transparent',
            border: 'none',
            color: it.disabled
              ? 'var(--text-faint)'
              : it.danger
                ? 'var(--danger)'
                : 'var(--text)',
            cursor: it.disabled ? 'default' : 'pointer',
            fontSize: '13px',
          }}
          onMouseEnter={(e) => {
            if (!it.disabled) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}