/**
 * Horizontal draggable divider between the Timeline canvas and the Inspector
 * panel. Adjusts the timeline's flex-basis as a percentage of the workspace
 * width. Clamps to [60%, 88%] so the inspector never collapses or dominates.
 * The split ratio is persisted to localStorage so it survives reloads.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { clamp } from './timelineUtils';

const STORAGE_KEY = 'reflect.timelineSplit';
const MIN_PCT = 60;
const MAX_PCT = 88;
const DEFAULT_PCT = 78;

function loadSplit(): number {
  const stored = Number(localStorage.getItem(STORAGE_KEY));
  return Number.isFinite(stored) && stored >= MIN_PCT && stored <= MAX_PCT ? stored : DEFAULT_PCT;
}

interface ResizeDividerProps {
  onResize: (timelinePct: number) => void;
}

/** Hook that owns the split ratio state + a divider handle. Returns the
 *  current timeline percentage and a <Divider> element to render. */
export function useResizeSplit() {
  const [timelinePct, setTimelinePct] = useState<number>(loadSplit);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(timelinePct));
  }, [timelinePct]);

  const onDrag = useCallback((clientX: number, containerLeft: number, containerWidth: number) => {
    const pct = ((clientX - containerLeft) / containerWidth) * 100;
    setTimelinePct(clamp(pct, MIN_PCT, MAX_PCT));
  }, []);

  return { timelinePct, onDrag };
}

export function ResizeDivider({
  onDragStart,
}: {
  onDragStart: (e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      onMouseDown={onDragStart}
      title="Drag to resize"
      style={{
        width: 6,
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 15,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 2,
          top: 0,
          bottom: 0,
          width: 2,
          background: 'var(--border)',
          transition: 'background var(--dur-fast) var(--ease-out)',
        }}
      />
    </div>
  );
}

export { MIN_PCT, MAX_PCT, DEFAULT_PCT };