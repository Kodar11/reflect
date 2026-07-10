import { useState, useCallback, useRef } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { timeToPx, pxToTime, snapTime, overlaps } from './timelineUtils';

const DRAG_THRESHOLD_PX = 4;

interface DragState {
  session: VerifiedSessionDto;
  startY: number;
  originalTop: number;
  currentTop: number;
  originalHeight: number;
  didMove: boolean;
}

interface UseBlockDragResult {
  dragging: DragState | null;
  preview: { session: VerifiedSessionDto; top: number; height: number; invalid: boolean } | null;
  onStartDrag: (id: string, e: React.MouseEvent) => void;
}

/**
 * Drag a session block vertically to change its time. Uses absolute top
 * updates during the drag (a preview overlay moves). On drop, if the proposed
 * envelope doesn't overlap another session, the `onCommit` callback receives
 * the new `startedAt`/`endedAt`. Otherwise the drag is rejected (snap-back).
 *
 * Day View only — no zoom parameter. All time math uses DAY_PX_PER_HOUR.
 */
export function useBlockDrag(
  baseDay: Date,
  sessions: VerifiedSessionDto[],
  onCommit: (id: string, newStartedAt: string, newEndedAt: string) => void,
): UseBlockDragResult {
  const [drag, setDrag] = useState<DragState | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const onStartDrag = useCallback((id: string, e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.resize-handle-top') || target.closest('.resize-handle-bottom')) return;
    if (e.button !== 0) return;

    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;

    const container = (e.currentTarget as HTMLElement).closest('[data-timeline-canvas]') as HTMLElement | null;
    containerRef.current = container;

    const rect = container?.getBoundingClientRect();
    const offsetY = rect ? e.clientY - rect.top + (container?.scrollTop ?? 0) : 0;
    const top = timeToPx(baseDay, new Date(session.startedAt));
    let didMove = false;

    setDrag({
      session,
      startY: offsetY,
      originalTop: top,
      currentTop: top,
      originalHeight: timeToPx(baseDay, new Date(session.endedAt)) - top,
      didMove: false,
    });

    const handleMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const y = ev.clientY - r.top + containerRef.current.scrollTop;
      const delta = y - offsetY;
      if (!didMove && Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      didMove = true;
      setDrag((prev) => (prev ? { ...prev, didMove: true, currentTop: prev.originalTop + delta } : prev));
    };

    const handleUp = () => {
      setDrag((prev) => {
        if (!prev) return prev;
        if (!prev.didMove) return null;
        const proposedStart = snapTime(pxToTime(baseDay, prev.currentTop));
        const duration = new Date(prev.session.endedAt).getTime() - new Date(prev.session.startedAt).getTime();
        const proposedEnd = new Date(proposedStart.getTime() + duration);
        if (
          proposedStart.getTime() === new Date(prev.session.startedAt).getTime() &&
          proposedEnd.getTime() === new Date(prev.session.endedAt).getTime()
        ) {
          return null;
        }

        const others = sessionsRef.current.filter((s) => s.id !== prev.session.id);
        const invalid = others.some((s) => overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt)));

        if (!invalid) onCommit(prev.session.id, proposedStart.toISOString(), proposedEnd.toISOString());
        return null;
      });
      cleanup();
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [baseDay, onCommit]);

  const preview = drag?.didMove
    ? {
        session: drag.session,
        top: drag.currentTop,
        height: drag.originalHeight,
        invalid: (() => {
          const proposedStart = snapTime(pxToTime(baseDay, drag.currentTop));
          const duration = new Date(drag.session.endedAt).getTime() - new Date(drag.session.startedAt).getTime();
          const proposedEnd = new Date(proposedStart.getTime() + duration);
          return sessionsRef.current
            .filter((s) => s.id !== drag.session.id)
            .some((s) => overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt)));
        })(),
      }
    : null;

  return { dragging: drag, preview, onStartDrag };
}

// ── Resize hook ──────────────────────────────────────────────────────────────

interface ResizeState {
  session: VerifiedSessionDto;
  edge: 'top' | 'bottom';
  startY: number;
  currentTop: number;
  currentHeight: number;
  originalStart: Date;
  originalEnd: Date;
}

interface UseBlockResizeResult {
  resizing: ResizeState | null;
  preview: { session: VerifiedSessionDto; top: number; height: number; invalid: boolean } | null;
  onStartResize: (id: string, edge: 'top' | 'bottom', e: React.MouseEvent) => void;
}

export function useBlockResize(
  baseDay: Date,
  sessions: VerifiedSessionDto[],
  onCommit: (id: string, newStartedAt: string, newEndedAt: string) => void,
): UseBlockResizeResult {
  const [resize, setResize] = useState<ResizeState | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const onStartResize = useCallback((id: string, edge: 'top' | 'bottom', e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;

    const container = (e.currentTarget as HTMLElement).closest('[data-timeline-canvas]') as HTMLElement | null;
    containerRef.current = container;

    const rect = container?.getBoundingClientRect();
    const offsetY = rect ? e.clientY - rect.top + (container?.scrollTop ?? 0) : 0;
    const top = timeToPx(baseDay, new Date(session.startedAt));
    const height = timeToPx(baseDay, new Date(session.endedAt)) - top;

    setResize({
      session,
      edge,
      startY: offsetY,
      currentTop: top,
      currentHeight: height,
      originalStart: new Date(session.startedAt),
      originalEnd: new Date(session.endedAt),
    });

    const handleMove = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      const r = containerRef.current.getBoundingClientRect();
      const y = ev.clientY - r.top + containerRef.current.scrollTop;
      const delta = y - offsetY;
      setResize((prev) => {
        if (!prev) return prev;
        if (prev.edge === 'bottom') {
          return { ...prev, currentHeight: Math.max(0, height + delta) };
        }
        const newTop = top + delta;
        const newHeight = height - delta;
        if (newHeight < 0) {
          return { ...prev, edge: 'bottom', startY: offsetY + height, currentTop: top + height, currentHeight: Math.abs(newHeight) };
        }
        return { ...prev, currentTop: newTop, currentHeight: newHeight };
      });
    };

    const handleUp = () => {
      setResize((prev) => {
        if (!prev) return prev;
        const proposedStart = snapTime(pxToTime(baseDay, prev.currentTop));
        const proposedEnd = snapTime(pxToTime(baseDay, prev.currentTop + prev.currentHeight));
        if (proposedEnd <= proposedStart) return null;

        const invalid = sessionsRef.current
          .filter((s) => s.id !== prev.session.id)
          .some((s) => overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt)));

        if (!invalid) onCommit(prev.session.id, proposedStart.toISOString(), proposedEnd.toISOString());
        return null;
      });
      cleanup();
    };

    const cleanup = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    e.preventDefault();
    e.stopPropagation();
  }, [baseDay, onCommit]);

  const preview = resize
    ? {
        session: resize.session,
        top: resize.currentTop,
        height: resize.currentHeight,
        invalid: (() => {
          const proposedStart = snapTime(pxToTime(baseDay, resize.currentTop));
          const proposedEnd = snapTime(pxToTime(baseDay, resize.currentTop + resize.currentHeight));
          if (proposedEnd <= proposedStart) return true;
          return sessionsRef.current
            .filter((s) => s.id !== resize.session.id)
            .some((s) => overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt)));
        })(),
      }
    : null;

  return { resizing: resize, preview, onStartResize };
}
