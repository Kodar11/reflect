/**
 * Inline text editor — the single reused primitive for any "click to edit"
 * text on the timeline (session rename, offline-activity title). No dialog,
 * no separate page. Controlled input that commits on Enter/blur and cancels
 * on Escape (the latter blows away the in-progress change).
 *
 * The parent controls mount/unmount; this component is purely presentational
 * + keyboard. Used by `SessionCard` (rename) and `TimeRangeSelector` (offline
 * title).
 */
import { useEffect, useRef, useState } from 'react';

interface InlineEditorProps {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
  autoFocus?: boolean;
  selectAll?: boolean;
}

export function InlineEditor({
  initial,
  placeholder,
  onCommit,
  onCancel,
  className,
  autoFocus = true,
  selectAll = true,
}: InlineEditorProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    if (autoFocus) ref.current.focus();
    if (selectAll) ref.current.select();
  }, [autoFocus, selectAll]);

  function commit() {
    const trimmed = value.trim();
    if (trimmed === initial) {
      onCancel();
      return;
    }
    onCommit(trimmed);
  }

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyUp={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') onCancel();
      }}
      onBlur={commit}
      onClick={(e) => e.stopPropagation()}
      className={`inline-edit ${className ?? ''}`}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--accent)',
        borderRadius: 'var(--radius-sm)',
        padding: '1px 6px',
        fontSize: 'inherit',
        fontFamily: 'inherit',
        color: 'var(--text)',
        outline: 'none',
        minWidth: '8ch',
      }}
    />
  );
}