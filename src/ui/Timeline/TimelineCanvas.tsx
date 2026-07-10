/**
 * The Day View calendar canvas: vertical time axis, sticky ruler, hour + half
 * hour grid, current-time line, and session blocks. Handles viewport
 * virtualization (only renders blocks that intersect the visible area) for
 * smooth scrolling with hundreds of sessions.
 *
 * One column, overlap-reject policy (no lane math). Day View only — no zoom.
 */
import { useRef, useState, useEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { Ruler } from './Ruler';
import { HourGrid } from './HourGrid';
import { CurrentTimeIndicator } from './CurrentTimeIndicator';
import { SessionBlock } from './SessionBlock';
import { EmptyState } from './EmptyState';
import {
  timeToPx,
  fullDayHeight,
  sortByStart,
  computeLaneLayout,
  RULER_WIDTH,
} from './timelineUtils';

export interface TimelineCanvasHandle {
  scrollToTime: (date: Date) => void;
  scrollToNow: () => void;
}

export interface TimelineCanvasProps {
  baseDay: Date;
  sessions: VerifiedSessionDto[];
  selectedId: string | null;
  isToday: boolean;
  previewSession?: { session: VerifiedSessionDto; top: number; height: number; invalid: boolean } | null;
  renameRequest?: { id: string; nonce: number } | null;
  readonly: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onStartDrag: (id: string, e: React.MouseEvent) => void;
  onStartResize: (id: string, edge: 'top' | 'bottom', e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent, session: VerifiedSessionDto) => void;
}

export const TimelineCanvas = forwardRef<TimelineCanvasHandle, TimelineCanvasProps>(
  function TimelineCanvas(
    {
      baseDay,
      sessions,
      selectedId,
      isToday,
      previewSession,
      renameRequest,
      readonly,
      onSelect,
      onRename,
      onStartDrag,
      onStartResize,
      onContextMenu,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ top: 0, height: 600 });

    useImperativeHandle(ref, () => ({
      scrollToTime: (date: Date) => {
        containerRef.current?.scrollTo({ top: timeToPx(baseDay, date), behavior: 'smooth' });
      },
      scrollToNow: () => {
        containerRef.current?.scrollTo({ top: timeToPx(baseDay, new Date()), behavior: 'smooth' });
      },
    }));

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      function update() {
        const current = containerRef.current;
        if (!current) return;
        setViewport({ top: current.scrollTop, height: current.clientHeight });
      }
      update();
      el.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      return () => {
        el.removeEventListener('scroll', update);
        window.removeEventListener('resize', update);
      };
    }, []);

    const totalHeight = fullDayHeight();
    const contentWidth = Math.max(0, (containerRef.current?.clientWidth ?? 600) - RULER_WIDTH - 16);

    const laneLayout = useMemo(() => computeLaneLayout(sessions), [sessions]);

    const blocks = useMemo(() => {
      const sorted = sortByStart(sessions);
      return sorted.map((s) => {
        const top = timeToPx(baseDay, new Date(s.startedAt));
        const rawHeight = timeToPx(baseDay, new Date(s.endedAt)) - top;
        const lane = laneLayout.get(s.id) ?? { lane: 0, laneCount: 1 };
        const laneWidth = contentWidth / lane.laneCount;
        return {
          session: s,
          top,
          height: rawHeight,
          left: lane.lane * laneWidth,
          width: laneWidth,
        };
      });
    }, [sessions, baseDay, contentWidth, laneLayout]);

    const visibleBlocks = useMemo(() => {
      const pad = 120;
      return blocks.filter(
        (b) => b.top + b.height >= viewport.top - pad && b.top <= viewport.top + viewport.height + pad,
      );
    }, [blocks, viewport]);

    const now = new Date();
    const canvasIsToday = baseDay.toDateString() === now.toDateString();
    const nowTop = canvasIsToday ? timeToPx(baseDay, now) : null;
    const hasSessions = sessions.length > 0;

    return (
      <div
        ref={containerRef}
        data-timeline-canvas
        onMouseDown={(e) => { if (e.target === e.currentTarget) onSelect(''); }}
        style={{
          position: 'relative',
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          background: 'var(--bg)',
          minWidth: 0,
        }}
      >
        <HourGrid height={totalHeight} />

        <Ruler scrollTop={viewport.top} viewportHeight={viewport.height} height={totalHeight} />

        {nowTop !== null && <CurrentTimeIndicator top={nowTop} width={contentWidth} />}

        {hasSessions ? (
          <div
            style={{
              position: 'absolute',
              left: RULER_WIDTH,
              top: 0,
              width: contentWidth,
              height: totalHeight,
            }}
          >
            {visibleBlocks.map(({ session, top, height, left, width }) => (
              <SessionBlock
                key={session.id}
                session={session}
                top={top}
                height={height}
                width={width}
                left={left}
                isSelected={selectedId === session.id}
                renameRequestNonce={renameRequest?.id === session.id ? renameRequest.nonce : undefined}
                readonly={readonly}
                actions={{
                  onSelect,
                  onRename,
                  onStartDrag,
                  onStartResize,
                  onContextMenu,
                }}
              />
            ))}

            {previewSession && (() => {
              const lane = laneLayout.get(previewSession.session.id) ?? { lane: 0, laneCount: 1 };
              const laneWidth = contentWidth / lane.laneCount;
              return (
                <SessionBlock
                  session={previewSession.session}
                  top={previewSession.top}
                  height={previewSession.height}
                  width={laneWidth}
                  left={lane.lane * laneWidth}
                  isSelected
                  isPreview
                  invalid={previewSession.invalid}
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
        ) : (
          <EmptyState isToday={canvasIsToday} />
        )}
      </div>
    );
  },
);
