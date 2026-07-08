/**
 * Popover for inserting offline activities. Two time chips (HH:MM), a title
 * input (reuses InlineEditor's commit-on-Enter behavior visually via a plain
 * input), and an optional app/browser field. Closes on Escape or outside
 * click. Anchored at the cursor; NOT a modal — the timeline stays put.
 *
 * Per spec: offline activities behave like generated sessions; only `source`
 * differs (visible as metadata, not as a visual break). The timeline engine
 * computes their duration from the range and yields `activeDuration = 0`.
 */
import { useEffect, useRef, useState } from 'react';

export interface OfflineDraft {
  startedAt: string; // ISO
  endedAt: string;   // ISO
  title: string;
  app?: string;
  browser?: string;
}

interface TimeRangeSelectorProps {
  anchorX: number;
  anchorY: number;
  defaults: { startedAt: Date; endedAt: Date };
  onSubmit: (draft: OfflineDraft) => void;
  onCancel: () => void;
}

export function TimeRangeSelector({ anchorX, anchorY, defaults, onSubmit, onCancel }: TimeRangeSelectorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [startStr, setStartStr] = useState(toLocalInput(defaults.startedAt));
  const [endStr, setEndStr] = useState(toLocalInput(defaults.endedAt));
  const [title, setTitle] = useState('');
  const [app, setApp] = useState('');
  const [browser, setBrowser] = useState('');

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  function submit() {
    if (!title.trim()) return; // require a label
    onSubmit({
      startedAt: fromLocalInput(startStr).toISOString(),
      endedAt: fromLocalInput(endStr).toISOString(),
      title: title.trim(),
      app: app.trim() || undefined,
      browser: browser.trim() || undefined,
    });
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'fixed',
        left: Math.min(anchorX, window.innerWidth - 280),
        top: Math.min(anchorY, window.innerHeight - 180),
        zIndex: 1000,
        width: 260,
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-md)',
        padding: '10px',
        fontSize: '13px',
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <TimeInput value={startStr} onChange={setStartStr} ariaLabel="start" />
        <span style={{ color: 'var(--text-muted)' }}>→</span>
        <TimeInput value={endStr} onChange={setEndStr} ariaLabel="end" />
      </div>
      <input
        autoFocus
        placeholder="What were you doing?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyUp={(e) => { if (e.key === 'Enter') submit(); }}
        style={inputStyle}
      />
      <input placeholder="App (optional)" value={app} onChange={(e) => setApp(e.target.value)} style={inputStyle} />
      <input placeholder="Browser (optional)" value={browser} onChange={(e) => setBrowser(e.target.value)} style={inputStyle} />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <button onClick={onCancel} style={btnStyle(false)}>Cancel</button>
        <button onClick={submit} disabled={!title.trim()} style={btnStyle(true)}>Add</button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 6,
  padding: '5px 8px',
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text)',
  fontSize: '13px',
};

function btnStyle(primary: boolean): React.CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 'var(--radius-sm)',
    border: '1px solid ' + (primary ? 'var(--accent)' : 'var(--border)'),
    background: primary ? 'var(--accent)' : 'transparent',
    color: primary ? 'var(--accent-text)' : 'var(--text-muted)',
    fontSize: '13px',
    cursor: 'pointer',
  };
}

function TimeInput({ value, onChange, ariaLabel }: { value: string; onChange: (v: string) => void; ariaLabel: string }) {
  return (
    <input
      type="time"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        flex: 1,
        padding: '4px 6px',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        color: 'var(--text)',
        fontSize: '13px',
      }}
    />
  );
}

function toLocalInput(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function fromLocalInput(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}