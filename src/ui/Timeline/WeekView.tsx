import { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { Ruler } from './Ruler';
import { HourGrid } from './HourGrid';
import { CurrentTimeIndicator } from './CurrentTimeIndicator';
import { SessionBlock } from './SessionBlock';
import {
  timeToPx,
  pxToTime,
  snapTime,
  overlaps,
  fullDayHeight,
  sortByStart,
  computeLaneLayout,
  RULER_WIDTH,
  TIMELINE_SIDE_PADDING,
  startOfDay,
  MIN_BLOCK_HEIGHT,
} from './timelineUtils';

interface WeekViewProps {
  baseDay: Date;
  sessions: VerifiedSessionDto[];
  selectedId: string | null;
  renameRequest?: { id: string; nonce: number } | null;
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onOverrideEnvelope: (id: string, newStartedAt: string, newEndedAt: string) => void;
  onContextMenu?: (e: React.MouseEvent, session: VerifiedSessionDto) => void;
  onCreateOfflineAt?: (time: Date, x: number, y: number) => void;
}

interface DragState {
  sessionId: string;
  startY: number;
  originalDayIdx: number;
  originalTop: number;
  originalHeight: number;
  currentDayIdx: number;
  currentTop: number;
  didMove: boolean;
}

interface ResizeState {
  sessionId: string;
  edge: 'top' | 'bottom';
  startY: number;
  dayIdx: number;
  originalTop: number;
  originalHeight: number;
  currentTop: number;
  currentHeight: number;
}

export function WeekView({
  baseDay,
  sessions,
  selectedId,
  renameRequest,
  onSelect,
  onRename,
  onOverrideEnvelope,
  onContextMenu,
  onCreateOfflineAt,
}: WeekViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<HTMLDivElement>(null);

  // Drag & Resize State
  const [drag, setDrag] = useState<DragState | null>(null);
  const [resize, setResize] = useState<ResizeState | null>(null);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  // Calculate Monday of the week containing baseDay
  const daysOfWeek = useMemo(() => {
    const date = new Date(baseDay);
    const dayOfWeek = date.getDay(); // 0 Sunday, 1 Monday, etc.
    const diff = date.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
    const monday = new Date(date.setDate(diff));
    
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return startOfDay(d);
    });
  }, [baseDay]);

  const totalHeight = fullDayHeight();

  // Drag Handlers
  const handleStartDrag = useCallback((id: string, e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.resize-handle-top') || target.closest('.resize-handle-bottom')) return;
    if (e.button !== 0) return;

    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;

    const colContainer = columnsRef.current;
    if (!colContainer) return;

    const colRect = colContainer.getBoundingClientRect();
    const scrollContainer = scrollContainerRef.current;
    const scrollTop = scrollContainer?.scrollTop ?? 0;

    const startedDate = new Date(session.startedAt);
    const dayIdx = daysOfWeek.findIndex((d) => d.toDateString() === startedDate.toDateString());
    if (dayIdx < 0) return;

    const top = timeToPx(daysOfWeek[dayIdx], startedDate);
    const height = timeToPx(daysOfWeek[dayIdx], new Date(session.endedAt)) - top;
    const clickY = e.clientY - colRect.top + scrollTop;

    setDrag({
      sessionId: id,
      startY: clickY,
      originalDayIdx: dayIdx,
      originalTop: top,
      originalHeight: height,
      currentDayIdx: dayIdx,
      currentTop: top,
      didMove: false,
    });

    const handleMove = (ev: MouseEvent) => {
      const container = columnsRef.current;
      const scrollC = scrollContainerRef.current;
      if (!container) return;

      const r = container.getBoundingClientRect();
      const sTop = scrollC?.scrollTop ?? 0;
      const mouseX = ev.clientX - r.left;
      const mouseY = ev.clientY - r.top + sTop;

      const colWidth = r.width / 7;
      const currentCol = Math.max(0, Math.min(6, Math.floor(mouseX / colWidth)));
      const deltaY = mouseY - clickY;

      setDrag((prev) => {
        if (!prev) return prev;
        const newDidMove = prev.didMove || Math.abs(deltaY) > 4 || currentCol !== prev.originalDayIdx;
        return {
          ...prev,
          didMove: newDidMove,
          currentDayIdx: currentCol,
          currentTop: prev.originalTop + deltaY,
        };
      });
    };

    const handleUp = async () => {
      setDrag((prev) => {
        if (prev && prev.didMove) {
          const proposedDay = daysOfWeek[prev.currentDayIdx];
          const proposedStart = snapTime(pxToTime(proposedDay, prev.currentTop));
          
          const sessionObj = sessionsRef.current.find((s) => s.id === prev.sessionId);
          if (sessionObj) {
            const duration = new Date(sessionObj.endedAt).getTime() - new Date(sessionObj.startedAt).getTime();
            const proposedEnd = new Date(proposedStart.getTime() + duration);

            // check overlap on target day
            const others = sessionsRef.current.filter((s) => s.id !== prev.sessionId);
            const invalid = others.some((s) =>
              overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt))
            );

            if (!invalid) {
              onOverrideEnvelope(prev.sessionId, proposedStart.toISOString(), proposedEnd.toISOString());
            }
          }
        }
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
  }, [daysOfWeek]);

  // Resize Handlers
  const handleStartResize = useCallback((id: string, edge: 'top' | 'bottom', e: React.MouseEvent) => {
    if (e.button !== 0) return;

    const session = sessionsRef.current.find((s) => s.id === id);
    if (!session) return;

    const colContainer = columnsRef.current;
    if (!colContainer) return;

    const colRect = colContainer.getBoundingClientRect();
    const scrollContainer = scrollContainerRef.current;
    const scrollTop = scrollContainer?.scrollTop ?? 0;

    const startedDate = new Date(session.startedAt);
    const dayIdx = daysOfWeek.findIndex((d) => d.toDateString() === startedDate.toDateString());
    if (dayIdx < 0) return;

    const top = timeToPx(daysOfWeek[dayIdx], startedDate);
    const height = timeToPx(daysOfWeek[dayIdx], new Date(session.endedAt)) - top;
    const clickY = e.clientY - colRect.top + scrollTop;

    setResize({
      sessionId: id,
      edge,
      startY: clickY,
      dayIdx,
      originalTop: top,
      originalHeight: height,
      currentTop: top,
      currentHeight: height,
    });

    const handleMove = (ev: MouseEvent) => {
      const container = columnsRef.current;
      const scrollC = scrollContainerRef.current;
      if (!container) return;

      const r = container.getBoundingClientRect();
      const sTop = scrollC?.scrollTop ?? 0;
      const mouseY = ev.clientY - r.top + sTop;
      const deltaY = mouseY - clickY;

      setResize((prev) => {
        if (!prev) return prev;
        if (prev.edge === 'bottom') {
          return { ...prev, currentHeight: Math.max(MIN_BLOCK_HEIGHT, height + deltaY) };
        }
        const newTop = top + deltaY;
        const newHeight = height - deltaY;
        if (newHeight < MIN_BLOCK_HEIGHT) {
          return prev;
        }
        return { ...prev, currentTop: newTop, currentHeight: newHeight };
      });
    };

    const handleUp = async () => {
      setResize((prev) => {
        if (prev) {
          const targetDay = daysOfWeek[prev.dayIdx];
          const proposedStart = snapTime(pxToTime(targetDay, prev.currentTop));
          const proposedEnd = snapTime(pxToTime(targetDay, prev.currentTop + prev.currentHeight));

          const sessionObj = sessionsRef.current.find((s) => s.id === prev.sessionId);
          if (sessionObj && proposedEnd > proposedStart) {
            const others = sessionsRef.current.filter((s) => s.id !== prev.sessionId);
            const invalid = others.some((s) =>
              overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt))
            );

            if (!invalid) {
              onOverrideEnvelope(prev.sessionId, proposedStart.toISOString(), proposedEnd.toISOString());
            }
          }
        }
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
  }, [daysOfWeek]);

  // Compute active previews
  const dragPreview = useMemo(() => {
    if (!drag || !drag.didMove) return null;
    const sessionObj = sessionsRef.current.find((s) => s.id === drag.sessionId);
    if (!sessionObj) return null;

    const proposedDay = daysOfWeek[drag.currentDayIdx];
    const proposedStart = snapTime(pxToTime(proposedDay, drag.currentTop));
    const duration = new Date(sessionObj.endedAt).getTime() - new Date(sessionObj.startedAt).getTime();
    const proposedEnd = new Date(proposedStart.getTime() + duration);

    const invalid = sessionsRef.current
      .filter((s) => s.id !== drag.sessionId)
      .some((s) => overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt)));

    return {
      sessionId: drag.sessionId,
      session: sessionObj,
      dayIdx: drag.currentDayIdx,
      top: drag.currentTop,
      height: drag.originalHeight,
      invalid,
    };
  }, [drag, daysOfWeek]);

  const resizePreview = useMemo(() => {
    if (!resize) return null;
    const sessionObj = sessionsRef.current.find((s) => s.id === resize.sessionId);
    if (!sessionObj) return null;

    const targetDay = daysOfWeek[resize.dayIdx];
    const proposedStart = snapTime(pxToTime(targetDay, resize.currentTop));
    const proposedEnd = snapTime(pxToTime(targetDay, resize.currentTop + resize.currentHeight));

    const invalid = sessionsRef.current
      .filter((s) => s.id !== resize.sessionId)
      .some((s) => overlaps(proposedStart, proposedEnd, new Date(s.startedAt), new Date(s.endedAt)));

    return {
      sessionId: resize.sessionId,
      session: sessionObj,
      dayIdx: resize.dayIdx,
      top: resize.currentTop,
      height: resize.currentHeight,
      invalid,
    };
  }, [resize, daysOfWeek]);

  const activePreview = dragPreview || resizePreview;

  const now = new Date();

  return (
    <div
      ref={scrollContainerRef}
      data-timeline-canvas
      onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(''); }}
      style={{
        position: 'relative',
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        background: 'var(--bg)',
        minWidth: 0,
        height: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'row',
          width: '100%',
          height: totalHeight,
          position: 'relative',
        }}
      >
        {/* Shared Left Time Column */}
        <Ruler height={totalHeight} />

        {/* 7 Columns Timeline Area */}
        <div
          ref={columnsRef}
          data-week-columns
          style={{
            flex: 1,
            display: 'flex',
            position: 'relative',
            height: '100%',
          }}
        >
          {/* Full-width Hour Grid overlay behind columns */}
          <HourGrid height={totalHeight} />

          {daysOfWeek.map((dayOfWeek, idx) => {
            const isToday = dayOfWeek.toDateString() === now.toDateString();
            const nowTop = isToday ? timeToPx(dayOfWeek, now) : null;

            // Get sessions for this specific day
            const daySessions = sessions.filter(
              (s) => new Date(s.startedAt).toDateString() === dayOfWeek.toDateString()
            );

            // Compute lanes for overlap display
            const laneLayout = computeLaneLayout(daySessions);

            return (
              <div
                key={idx}
                onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(''); }}
                onDoubleClick={(e) => {
                  if (e.target === e.currentTarget) {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickY = e.clientY - rect.top;
                    const clickTime = pxToTime(dayOfWeek, clickY);
                    onCreateOfflineAt?.(clickTime, e.clientX, e.clientY);
                  }
                }}
                style={{
                  flex: 1,
                  position: 'relative',
                  height: '100%',
                  borderRight: idx < 6 ? '1px solid var(--border)' : 'none',
                  paddingLeft: TIMELINE_SIDE_PADDING,
                  paddingRight: TIMELINE_SIDE_PADDING,
                  boxSizing: 'border-box',
                }}
              >
                {/* Header tag for the day (e.g. "Mon 6") on top of the column */}
                <div
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 20,
                    background: isToday ? 'var(--accent-soft)' : 'var(--bg-secondary)',
                    borderBottom: '1px solid var(--border)',
                    textAlign: 'center',
                    padding: '4px 0',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: isToday ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {dayOfWeek.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}
                </div>

                {/* Current Time Indicator in this column if it's today */}
                {nowTop !== null && <CurrentTimeIndicator top={nowTop} />}

                {/* Render sessions */}
                {daySessions.map((session) => {
                  const isSelected = selectedId === session.id;
                  const isBeingDragged = drag?.sessionId === session.id && drag.didMove;
                  const isBeingResized = resize?.sessionId === session.id;

                  // Hide or dim during drag/resize previews
                  if (isBeingDragged || isBeingResized) return null;

                  const top = timeToPx(dayOfWeek, new Date(session.startedAt));
                  const height = timeToPx(dayOfWeek, new Date(session.endedAt)) - top;
                  const lane = laneLayout.get(session.id) ?? { lane: 0, laneCount: 1 };
                  
                  // Compute lanes width relative to the padded column width
                  const colWidth = (columnsRef.current?.clientWidth ?? 700) / 7 - TIMELINE_SIDE_PADDING * 2;
                  const laneWidth = Math.max(0, colWidth / lane.laneCount);

                  return (
                    <SessionBlock
                      key={session.id}
                      session={session}
                      top={top}
                      height={height}
                      width={laneWidth}
                      left={lane.lane * laneWidth}
                      isSelected={isSelected}
                      renameRequestNonce={renameRequest?.id === session.id ? renameRequest.nonce : undefined}
                      readonly={false}
                      actions={{
                        onSelect,
                        onRename,
                        onStartDrag: handleStartDrag,
                        onStartResize: handleStartResize,
                        onContextMenu,
                      }}
                    />
                  );
                })}

                {/* Render active preview block inside this column if it lands here */}
                {activePreview && activePreview.dayIdx === idx && (() => {
                  const colWidth = (columnsRef.current?.clientWidth ?? 700) / 7 - TIMELINE_SIDE_PADDING * 2;
                  return (
                    <SessionBlock
                      session={activePreview.session}
                      top={activePreview.top}
                      height={activePreview.height}
                      width={colWidth}
                      left={0}
                      isSelected
                      isPreview
                      invalid={activePreview.invalid}
                      readonly
                      actions={{
                        onSelect: () => {},
                        onRename: () => {},
                        onStartDrag: () => {},
                        onStartResize: () => {},
                        onContextMenu: () => {},
                      }}
                    />
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
