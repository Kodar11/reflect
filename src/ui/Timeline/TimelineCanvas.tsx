/**
 * The Day View calendar canvas: vertical time axis, sticky ruler, hour + half
 * hour grid, current-time line, and session blocks. Handles viewport
 * virtualization (only renders blocks that intersect the visible area) for
 * smooth scrolling with hundreds of sessions.
 *
 * Blocks are placed by `computeDayLayout`: exact time on the vertical axis,
 * collision-free lanes on the horizontal one. `pxPerHour` is the Day View's
 * density — a uniform scale shared by the ruler, the grid and every block.
 */
import { useRef, useState, useEffect, useLayoutEffect, useMemo, forwardRef, useImperativeHandle } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { Ruler } from './Ruler';
import { HourGrid } from './HourGrid';
import { CurrentTimeIndicator } from './CurrentTimeIndicator';
import { SessionBlock } from './SessionBlock';
import { EmptyState } from './EmptyState';
import { FocusBand } from '../Focus/FocusBand';
import type { FocusSessionDto } from '../Focus/useFocus';
import {
  timeToPx,
  fullDayHeight,
  DAY_PX_PER_HOUR,
  RULER_WIDTH,
  TIMELINE_SIDE_PADDING,
  pxToTime,
} from './timelineUtils';
import { computeDayLayout, MIN_MARKER_HEIGHT } from './timelineLayout';

/** No layout effects during server rendering (static-markup tests). */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export interface TimelineCanvasHandle {
  scrollToTime: (date: Date) => void;
  scrollToNow: () => void;
}

export interface TimelineCanvasProps {
  baseDay: Date;
  sessions: VerifiedSessionDto[];
  focusSessions?: FocusSessionDto[];
  /** Vertical scale. Defaults to the base Day View scale. */
  pxPerHour?: number;
  selectedId: string | null;
  isToday: boolean;
  previewSession?: { session: VerifiedSessionDto; top: number; height: number; invalid: boolean } | null;
  renameRequest?: { id: string; nonce: number } | null;
  readonly: boolean;
  onSelect: (id: string) => void;
  onOpenFocus: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onStartDrag: (id: string, e: React.MouseEvent) => void;
  onStartResize: (id: string, edge: 'top' | 'bottom', e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent, session: VerifiedSessionDto) => void;
  onCreateOfflineAt?: (time: Date, x: number, y: number) => void;
}

export const TimelineCanvas = forwardRef<TimelineCanvasHandle, TimelineCanvasProps>(
  function TimelineCanvas(
    {
      baseDay,
      sessions,
      focusSessions = [],
      pxPerHour = DAY_PX_PER_HOUR,
      selectedId,
      isToday,
      previewSession,
      renameRequest,
      readonly,
      onSelect,
      onOpenFocus,
      onRename,
      onStartDrag,
      onStartResize,
      onContextMenu,
      onCreateOfflineAt,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState({ top: 0, height: 600, width: 600 });

    useImperativeHandle(ref, () => ({
      scrollToTime: (date: Date) => {
        containerRef.current?.scrollTo({ top: timeToPx(baseDay, date, pxPerHour), behavior: 'smooth' });
      },
      scrollToNow: () => {
        containerRef.current?.scrollTo({ top: timeToPx(baseDay, new Date(), pxPerHour), behavior: 'smooth' });
      },
    }));

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      function update() {
        const current = containerRef.current;
        if (!current) return;
        setViewport((prev) =>
          prev.top === current.scrollTop && prev.height === current.clientHeight && prev.width === current.clientWidth
            ? prev
            : { top: current.scrollTop, height: current.clientHeight, width: current.clientWidth },
        );
      }
      update();
      el.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      // The inspector divider resizes the canvas without resizing the window.
      const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
      observer?.observe(el);
      return () => {
        el.removeEventListener('scroll', update);
        window.removeEventListener('resize', update);
        observer?.disconnect();
      };
    }, []);

    // Changing density rescales the canvas; keep the same moment in the middle
    // of the viewport instead of jumping to another part of the day.
    const previousPxPerHour = useRef(pxPerHour);
    useIsomorphicLayoutEffect(() => {
      const el = containerRef.current;
      const previous = previousPxPerHour.current;
      previousPxPerHour.current = pxPerHour;
      if (!el || previous === pxPerHour) return;
      const middle = el.scrollTop + el.clientHeight / 2;
      el.scrollTop = middle * (pxPerHour / previous) - el.clientHeight / 2;
    }, [pxPerHour]);

    const totalHeight = fullDayHeight(pxPerHour);
    const contentWidth = Math.max(0, viewport.width - RULER_WIDTH - TIMELINE_SIDE_PADDING * 2);

    const layout = useMemo(() => computeDayLayout(sessions, baseDay, pxPerHour), [sessions, baseDay, pxPerHour]);

    const blocks = useMemo(() => {
      const byId = new Map(sessions.map((s) => [s.id, s]));
      return layout.blocks.map((block) => ({ session: byId.get(block.id)!, block }));
    }, [sessions, layout]);

    const visibleBlocks = useMemo(() => {
      const pad = 120;
      return blocks.filter(
        ({ block }) =>
          block.top + block.inset + block.height >= viewport.top - pad && block.top <= viewport.top + viewport.height + pad,
      );
    }, [blocks, viewport.top, viewport.height]);

    // One tab stop for the timeline: the selected block, else the first one in view.
    const tabStopId = visibleBlocks.some(({ session }) => session.id === selectedId)
      ? selectedId
      : visibleBlocks[0]?.session.id ?? null;

    const focusBands = useMemo(() => {
      const dayStart = baseDay.getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      const now = Date.now();
      return focusSessions
        .filter((fs) => {
          const start = fs.startedAt ? new Date(fs.startedAt).getTime() : now;
          const end = fs.endedAt ? new Date(fs.endedAt).getTime() : now;
          return start < dayEnd && end > dayStart;
        })
        .map((fs) => {
          const startTime = fs.startedAt ? new Date(fs.startedAt) : new Date();
          const endTime = fs.endedAt ? new Date(fs.endedAt) : new Date();
          const startMs = Math.max(dayStart, startTime.getTime());
          const endMs = Math.min(dayEnd, endTime.getTime());
          const top = timeToPx(baseDay, new Date(startMs), pxPerHour);
          const bottom = timeToPx(baseDay, new Date(endMs), pxPerHour);
          return {
            session: fs,
            top,
            height: Math.max(2, bottom - top),
            width: contentWidth,
            left: 0,
            isActive: fs.state === 'active' || fs.state === 'paused',
          };
        });
    }, [focusSessions, baseDay, contentWidth, pxPerHour]);

    const now = new Date();
    const canvasIsToday = baseDay.toDateString() === now.toDateString();
    const nowTop = canvasIsToday ? timeToPx(baseDay, now, pxPerHour) : null;
    const hasSessions = sessions.length > 0;

    return (
      <div
        ref={containerRef}
        data-timeline-canvas
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                onSelect('');
              }
            }}
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
          {/* Left Time Column (fixed width, scrolls vertically naturally with flex row) */}
          <Ruler height={totalHeight} pxPerHour={pxPerHour} />

          {/* Right Day Canvas */}
          <div
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            onSelect('');
          }
        }}
            onDoubleClick={(e) => {
              if (e.target === e.currentTarget) {
                const rect = e.currentTarget.getBoundingClientRect();
                const clickY = e.clientY - rect.top;
                const clickTime = pxToTime(baseDay, clickY, pxPerHour);
                onCreateOfflineAt?.(clickTime, e.clientX, e.clientY);
              }
            }}
            style={{
              flex: 1,
              position: 'relative',
              height: '100%',
              overflow: 'hidden',
            }}
          >
            <HourGrid height={totalHeight} pxPerHour={pxPerHour} />

            {/* Session Blocks and Current Time Line Container */}
            <div
              onMouseDown={(e) => {
                if (e.target === e.currentTarget) {
                  onSelect('');
                }
              }}
              onDoubleClick={(e) => {
                if (e.target === e.currentTarget) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const clickY = e.clientY - rect.top;
                  const clickTime = pxToTime(baseDay, clickY, pxPerHour);
                  onCreateOfflineAt?.(clickTime, e.clientX, e.clientY);
                }
              }}
              style={{
                position: 'absolute',
                left: TIMELINE_SIDE_PADDING,
                right: TIMELINE_SIDE_PADDING,
                top: 0,
                bottom: 0,
              }}
            >
              {focusBands.map((band) => (
                <FocusBand
                  key={band.session.id}
                  session={band.session}
                  top={band.top}
                  height={band.height}
                  width={band.width}
                  left={band.left}
                  isActive={band.isActive}
                  onOpenFocus={onOpenFocus}
                />
              ))}

              {/* Keyed by scale so a density change repositions the line at once
                  instead of easing there. */}
              {nowTop !== null && <CurrentTimeIndicator key={pxPerHour} top={nowTop} />}

              {hasSessions ? (
                <>
                  {visibleBlocks.map(({ session, block }) => (
                    <SessionBlock
                      key={session.id}
                      session={session}
                      top={block.top + block.inset}
                      height={block.height}
                      trueHeight={block.trueHeight - block.inset}
                      width={`${block.width * 100}%`}
                      left={`${block.left * 100}%`}
                      widthPx={block.width * contentWidth}
                      isSelected={selectedId === session.id}
                      tabbable={tabStopId === session.id}
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
                    const lane = layout.byId.get(previewSession.session.id) ?? { left: 0, width: 1 };
                    return (
                      <SessionBlock
                        session={previewSession.session}
                        top={previewSession.top}
                        height={Math.max(MIN_MARKER_HEIGHT, previewSession.height)}
                        width={`${lane.width * 100}%`}
                        left={`${lane.left * 100}%`}
                        widthPx={lane.width * contentWidth}
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
                </>
              ) : (
                <EmptyState isToday={canvasIsToday} />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  },
);
