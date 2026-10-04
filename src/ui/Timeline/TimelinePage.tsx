/**
 * TimelinePage — the primary Multi-View Timeline workspace (Stage 3.7).
 *
 * Layout:
 *   Sticky toolbar (day nav · undo/redo · + offline)
 *   ├─ Timeline workspace (Day / Week / Month / Year / Custom views)
 *   ┊ Resize divider
 *   └─ Inspector panel (DailySummary or SessionDetail; always visible)
 *
 * State philosophy:
 *   - A single `day` (local Date at start-of-day) drives the view context.
 *   - Single selection (`selectedId: string | null`).
 *   - Fetch range is dynamic depending on the active view.
 *   - All mutations go through `window.timeline.apply`.
 *
 * Active-session selection stability:
 *   - A selected session must never disappear from the Inspector because of a
 *     transient refresh/session-resolution gap.
 *   - Session IDs may be re-derived while an active session is growing, so the
 *     first event ID is used as a stable anchor.
 *   - If a refresh temporarily omits the selected session, the previous session
 *     snapshot is retained until the next successful resolution.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import type { UseFocusResult, FocusSessionDto } from '../Focus/useFocus';
import { TimelineToolbar, type TimelineView } from './TimelineToolbar';
import { TimelineCanvas, type TimelineCanvasHandle } from './TimelineCanvas';
import { WeekView } from './WeekView';
import { MonthView } from './MonthView';
import { YearView } from './YearView';
import { CustomView } from './CustomView';
import { InspectorPanel, type InspectorActions } from './InspectorPanel';
import { ContextMenu } from './ContextMenu';
import { TimeRangeSelector, type OfflineDraft } from './TimeRangeSelector';
import { useTimelineKeyboard } from './useTimelineKeyboard';
import { useBlockDrag, useBlockResize } from './useBlockDrag';
import { ResizeDivider, useResizeSplit } from './ResizeDivider';
import {
  startOfDay,
  endOfDay,
  sortByStart,
  sessionDetailsText,
  snapTime,
} from './timelineUtils';
import { resolveSelection } from './timelineSelection';
import { parseDensity, pxPerHourFor, type TimelineDensity } from './timelineLayout';

const POLL_MS = 2500;
const DENSITY_STORAGE_KEY = 'timeline.density';

function loadDensity(): TimelineDensity {
  try {
    return parseDensity(window.localStorage.getItem(DENSITY_STORAGE_KEY));
  } catch {
    return parseDensity(null);
  }
}

export interface TimelinePageProps {
  onNavigateToRule?: (ruleId: string) => void;
  onCreateRuleFromSession?: (session: VerifiedSessionDto) => void;
  onNavigateToFocus?: (sessionId: string) => void;
  focus: UseFocusResult;
  /**
   * Open the timeline at a specific day / view and optionally select one
   * block — used by Reflection's evidence links. Applied once per `nonce`.
   */
  navigationTarget?: {
    day: string;
    view: 'day' | 'week' | 'month' | 'year';
    activityId: string | null;
    nonce: number;
  } | null;
}

export function TimelinePage({
  onNavigateToRule,
  onCreateRuleFromSession,
  onNavigateToFocus,
  focus,
  navigationTarget,
}: TimelinePageProps) {
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [view, setView] = useState<TimelineView>('day');
  const [density, setDensity] = useState<TimelineDensity>(loadDensity);
  const pxPerHour = pxPerHourFor(density);

  const changeDensity = useCallback((next: TimelineDensity) => {
    setDensity(next);
    try {
      window.localStorage.setItem(DENSITY_STORAGE_KEY, next);
    } catch {
      // A preference that cannot be saved still applies for this session.
    }
  }, []);

  const [sessions, setSessions] = useState<VerifiedSessionDto[]>([]);
  const [focusSessions, setFocusSessions] = useState<FocusSessionDto[]>([]);

  const [activeEdits, setActiveEdits] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [renameRequest, setRenameRequest] = useState<{
    id: string;
    nonce: number;
  } | null>(null);

  const [toast, setToast] = useState<string | null>(null);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    session: VerifiedSessionDto;
  } | null>(null);

  const [offlinePopover, setOfflinePopover] = useState<{
    x: number;
    y: number;
    startedAt?: Date;
    endedAt?: Date;
  } | null>(null);

  // Custom view range states
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString().split('T')[0];
  });

  const [customEnd, setCustomEnd] = useState(() => {
    return new Date().toISOString().split('T')[0];
  });

  const canvasRef = useRef<TimelineCanvasHandle>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);

  /**
   * Stable event anchor for the currently selected session.
   *
   * Active sessions can be re-derived as new events arrive, which means their
   * generated session ID can change. The first event ID gives us a stable
   * identity across those re-derivations.
   */
  const selectedAnchorRef = useRef<number | null>(null);

  /**
   * Last successfully resolved selected session.
   *
   * This is deliberately kept outside the rendered session list so a transient
   * refresh failure cannot make the Inspector fall back to Daily Summary.
   */
  const selectedSessionRef = useRef<VerifiedSessionDto | null>(null);

  const { timelinePct, onDrag } = useResizeSplit();

  /**
   * Deep link from Reflection: jump to the evidence's day and select the
   * activity. The selection is resolved by the normal refresh once that day's
   * sessions have loaded.
   */
  const navigationNonce = navigationTarget?.nonce ?? null;
  useEffect(() => {
    if (!navigationTarget) return;
    const target = new Date(navigationTarget.day);
    if (Number.isNaN(target.getTime())) return;
    setDay(startOfDay(target));
    setView(navigationTarget.view);
    if (navigationTarget.activityId) {
      selectedAnchorRef.current = null;
      selectedSessionRef.current = null;
      setSelectedId(navigationTarget.activityId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationNonce]);

  const isToday = day.toDateString() === new Date().toDateString();
  const readOnly =
    view === 'day'
      ? !isToday
      : view === 'week'
        ? false
        : true;

  const dayLabel = getDayLabel(
    day,
    isToday,
    view,
    customStart,
    customEnd,
  );

  const eventIdsFor = useCallback(
    (id: string): number[] => {
      return sessions.find((s) => s.id === id)?.eventIds ?? [];
    },
    [sessions],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  /**
   * Preserve the currently selected session during refresh.
   *
   * The timeline backend can temporarily return a list that does not contain
   * an active session while that session is being re-derived. Replacing the
   * whole list in that moment would make InspectorPanel lose `selected`.
   *
   * We therefore retain the last known selected session until the backend
   * produces a resolved version again.
   */
  const mergeSelectedSession = useCallback(
    (
      nextSessions: VerifiedSessionDto[],
      currentSelectedId: string | null,
    ): VerifiedSessionDto[] => {
      if (!currentSelectedId) {
        return nextSessions;
      }

      const selectedInNext = nextSessions.some(
        (session) => session.id === currentSelectedId,
      );

      if (selectedInNext) {
        const resolved = nextSessions.find(
          (session) => session.id === currentSelectedId,
        );

        if (resolved) {
          selectedSessionRef.current = resolved;
        }

        return nextSessions;
      }

      const previousSelected = selectedSessionRef.current;

      if (!previousSelected) {
        return nextSessions;
      }

      /**
       * Only preserve the previous snapshot when it is genuinely the session
       * the user selected. This avoids keeping arbitrary stale sessions alive.
       */
      const previousAnchor =
        previousSelected.eventIds[0] ?? null;

      const selectedAnchor = selectedAnchorRef.current;

      if (
        selectedAnchor !== null &&
        previousAnchor !== null &&
        selectedAnchor === previousAnchor
      ) {
        return sortByStart([
          ...nextSessions,
          previousSelected,
        ]);
      }

      return nextSessions;
    },
    [],
  );

  const refresh = useCallback(async () => {
    try {
      let startRange: Date;
      let endRange: Date;

      if (view === 'day') {
        startRange = startOfDay(day);
        endRange = endOfDay(day);
      } else if (view === 'week') {
        startRange = getMonday(day);
        endRange = endOfDay(
          new Date(
            startRange.getTime() +
              6 * 24 * 3600 * 1000,
          ),
        );
      } else if (view === 'month') {
        startRange = startOfDay(
          new Date(
            day.getFullYear(),
            day.getMonth(),
            1,
          ),
        );

        endRange = endOfDay(
          new Date(
            day.getFullYear(),
            day.getMonth() + 1,
            0,
          ),
        );
      } else if (view === 'year') {
        startRange = startOfDay(
          new Date(day.getFullYear(), 0, 1),
        );

        endRange = endOfDay(
          new Date(day.getFullYear(), 11, 31),
        );
      } else {
        // Custom View
        startRange = startOfDay(
          new Date(customStart + 'T00:00:00'),
        );

        endRange = endOfDay(
          new Date(customEnd + 'T23:59:59'),
        );
      }

      const now = new Date();

      const isTodayRange =
        view === 'day' &&
        day.toDateString() === now.toDateString();

      const [list, status, focusList] =
        await Promise.all([
          isTodayRange
            ? window.timeline.getToday()
            : window.timeline.getRange(
                startRange.toISOString(),
                endRange.toISOString(),
              ),
          window.timeline.status(),
          window.focusMode.getSessionsByRange(
            startRange.toISOString(),
            endRange.toISOString(),
          ),
        ]);

      const sortedList = sortByStart(list);

      /**
       * Important:
       * Read the current selected ID at refresh time rather than relying on
       * a stale closure value. The selected session can change independently
       * while polling is running.
       */
      setSessions((previousSessions) => {
        const currentSelectedId =
          selectedIdRef.current;

        const merged = mergeSelectedSession(
          sortedList,
          currentSelectedId,
        );

        /**
         * If the selected session is genuinely present in the fresh result,
         * remember the fresh version. This replaces the temporary snapshot.
         */
        if (currentSelectedId) {
          const resolved = sortedList.find(
            (session) => session.id === currentSelectedId,
          );

          if (resolved) {
            selectedSessionRef.current = resolved;
          }
        }

        /**
         * Keep React state useful even if the previous array was empty.
         */
        if (
          merged.length === 0 &&
          previousSessions.length === 0
        ) {
          return merged;
        }

        return merged;
      });

      setFocusSessions(focusList);
      setActiveEdits(status.activeEdits);
    } catch (e) {
      console.error(
        '[TimelinePage] refresh failed',
        e,
      );

      showToast(
        `Failed to load: ${
          (e as Error)?.message ?? String(e)
        }`,
      );
    }
  }, [
    day,
    view,
    customStart,
    customEnd,
    mergeSelectedSession,
    showToast,
  ]);

  /**
   * Keep a ref synchronized with selectedId so polling/refresh callbacks can
   * always see the latest selection without forcing refresh() to recreate
   * itself every time selection changes.
   */
  const selectedIdRef = useRef<string | null>(null);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    refresh();

    if (view === 'day' && isToday) {
      canvasRef.current?.scrollToNow();
    }
  }, [refresh, view, isToday]);

  // Refresh the timeline when the active focus session starts or stops so the
  // background band appears/disappears without waiting for the poll interval.
  useEffect(() => {
    refresh();
  }, [focus.activeSession?.session.id, refresh]);

  /**
   * Reconcile the selection after sessions are refreshed.
   *
   * Critical rule:
   *
   *     A missing selected session is NOT automatically a reason to clear
   *     selection.
   *
   * resolveSelection can legitimately return null while an active session is
   * temporarily absent during re-resolution. In that case we keep selectedId
   * and the preserved session snapshot keeps Inspector stable.
   */
  useEffect(() => {
    if (!selectedId) {
      return;
    }

    const { nextId, nextAnchor } =
      resolveSelection(
        sessions,
        selectedId,
        selectedAnchorRef.current,
      );

    /**
     * Successful resolution.
     */
    if (nextId) {
      selectedAnchorRef.current = nextAnchor;

      const resolved = sessions.find(
        (session) => session.id === nextId,
      );

      if (resolved) {
        selectedSessionRef.current = resolved;
      }

      if (nextId !== selectedId) {
        selectedIdRef.current = nextId;
        setSelectedId(nextId);
      }

      return;
    }

    /**
     * IMPORTANT:
     *
     * Do NOT do:
     *
     *     setSelectedId(null)
     *
     * here.
     *
     * A transient failure must not switch Inspector to Daily Summary.
     *
     * The next refresh will either resolve the active session again or the
     * user can explicitly clear selection.
     */
  }, [sessions, selectedId]);

  // ── mutations ─────────────────────────────────────────────────────────────

  const applyEdit = useCallback(
    async (
      operation: string,
      payload: unknown,
    ) => {
      try {
        await window.timeline.apply({
          operation,
          payload,
        });
      } catch (e) {
        showToast(
          `Edit failed: ${
            (e as Error)?.message ?? String(e)
          }`,
        );
      }

      await refresh();
    },
    [refresh, showToast],
  );

  const undo = useCallback(async () => {
    try {
      await window.timeline.undo();
    } catch (e) {
      showToast(
        `Undo failed: ${
          (e as Error)?.message ?? String(e)
        }`,
      );
    }

    await refresh();
  }, [refresh, showToast]);

  const redo = useCallback(async () => {
    try {
      await window.timeline.redo();
    } catch (e) {
      showToast(
        `Redo failed: ${
          (e as Error)?.message ?? String(e)
        }`,
      );
    }

    await refresh();
  }, [refresh, showToast]);

  const canUndo = activeEdits > 0;

  const [canRedo, setCanRedo] = useState(false);

  useEffect(() => {
    setCanRedo(false);
  }, [activeEdits]);

  const onRename = useCallback(
    (id: string, newTitle: string) =>
      applyEdit('rename', {
        eventIdsHint: eventIdsFor(id),
        newTitle,
      }),
    [applyEdit, eventIdsFor],
  );

  const onSplit = useCallback(
    (id: string) =>
      applyEdit('split', {
        eventIdsHint: eventIdsFor(id),
        afterEventIndex: 0,
      }),
    [applyEdit, eventIdsFor],
  );

  const onMerge = useCallback(
    (id: string) =>
      applyEdit('merge', {
        eventIdsHint: eventIdsFor(id),
      }),
    [applyEdit, eventIdsFor],
  );

  const onDuplicate = useCallback(
    (id: string) =>
      applyEdit('duplicate', {
        eventIdsHint: eventIdsFor(id),
      }),
    [applyEdit, eventIdsFor],
  );

  const onDelete = useCallback(
    (id: string) =>
      applyEdit('delete', {
        eventIdsHint: eventIdsFor(id),
      }),
    [applyEdit, eventIdsFor],
  );

  const onToggleOffline = useCallback(
    (id: string, offline: boolean) =>
      applyEdit('mark_offline', {
        eventIdsHint: eventIdsFor(id),
        offline,
      }),
    [applyEdit, eventIdsFor],
  );

  const onNoteChange = useCallback(
    (id: string, note: string) =>
      applyEdit('note', {
        eventIdsHint: eventIdsFor(id),
        note,
      }),
    [applyEdit, eventIdsFor],
  );

  const onOverrideEnvelope = useCallback(
    (
      id: string,
      newStartedAt: string,
      newEndedAt: string,
    ) =>
      applyEdit('override_envelope', {
        eventIdsHint: eventIdsFor(id),
        newStartedAt,
        newEndedAt,
      }),
    [applyEdit, eventIdsFor],
  );

  const onAssignActivity = useCallback(
    (
      id: string,
      activityId: string | null,
    ) =>
      applyEdit('assign_activity', {
        eventIdsHint: eventIdsFor(id),
        activityId,
      }),
    [applyEdit, eventIdsFor],
  );

  const onUpdateActivity = useCallback(
    async (
      id: string,
      name: string,
      color: string,
    ) => {
      try {
        await window.timeline.saveActivity({
          id,
          name,
          color,
        });

        await refresh();
      } catch (e) {
        showToast(
          `Update activity failed: ${
            (e as Error)?.message ?? String(e)
          }`,
        );
      }
    },
    [refresh, showToast],
  );

  // ── drag / resize (day view today only) ────────────────────────────────────

  const isDayEditable =
    view === 'day' && isToday;

  const {
    preview: dragPreview,
    onStartDrag,
  } = useBlockDrag(
    day,
    sessions,
    !isDayEditable
      ? noopCommit
      : onOverrideEnvelope,
    pxPerHour,
  );

  const {
    preview: resizePreview,
    onStartResize,
  } = useBlockResize(
    day,
    sessions,
    !isDayEditable
      ? noopCommit
      : onOverrideEnvelope,
    pxPerHour,
  );

  const preview = !isDayEditable
    ? null
    : (dragPreview ?? resizePreview);

  // Poll in editable modes to keep timeline live
  useEffect(() => {
    if (
      readOnly ||
      (view === 'day' && !isToday)
    ) {
      return;
    }

    const t = setInterval(() => {
      const busy =
        !!contextMenu ||
        !!offlinePopover ||
        !!dragPreview ||
        !!resizePreview;

      if (!busy) {
        refresh();
      }
    }, POLL_MS);

    return () => clearInterval(t);
  }, [
    refresh,
    readOnly,
    view,
    isToday,
    contextMenu,
    offlinePopover,
    dragPreview,
    resizePreview,
  ]);

  const submitOffline = useCallback(
    async (draft: OfflineDraft) => {
      setOfflinePopover(null);
      await applyEdit(
        'create_offline',
        draft,
      );
    },
    [applyEdit],
  );

  const onCopyDetails = useCallback(
    (s: VerifiedSessionDto) => {
      const text = sessionDetailsText(s);

      try {
        navigator.clipboard?.writeText(text);
        showToast('Copied session details');
      } catch {
        showToast(text);
      }
    },
    [showToast],
  );

  // ── selection ─────────────────────────────────────────────────────────────

  const onSelect = useCallback(
    (id: string) => {
      const session = sessions.find(
        (s) => s.id === id,
      );

      if (!id) {
        selectedAnchorRef.current = null;
        selectedSessionRef.current = null;
        selectedIdRef.current = null;
        setSelectedId(null);
        return;
      }

      /**
       * Establish the stable anchor immediately.
       */
      selectedAnchorRef.current =
        session?.eventIds[0] ?? null;

      /**
       * Store the exact session snapshot that the user selected.
       * This is what protects the Inspector during a transient refresh gap.
       */
      if (session) {
        selectedSessionRef.current = session;
      }

      selectedIdRef.current = id;
      setSelectedId(id);
    },
    [sessions],
  );

  const onOpenFocus = useCallback(
    (id: string) => {
      onNavigateToFocus?.(id);
    },
    [onNavigateToFocus],
  );

  // ── keyboard ──────────────────────────────────────────────────────────────

  useTimelineKeyboard(selectedId, {
    editable: !readOnly,

    onRename: (id) => {
      const session = sessions.find(
        (s) => s.id === id,
      );

      if (session) {
        selectedAnchorRef.current =
          session.eventIds[0] ?? null;

        selectedSessionRef.current = session;
      }

      selectedIdRef.current = id;
      setSelectedId(id);

      setRenameRequest((prev) => ({
        id,
        nonce: (prev?.nonce ?? 0) + 1,
      }));
    },

    onDelete,

    onUndo: undo,

    onRedo: redo,

    onNavigate: (dir) => {
      const sorted = sortByStart(sessions);

      const idx = sorted.findIndex(
        (s) => s.id === selectedId,
      );

      const nextIdx =
        idx < 0
          ? dir > 0
            ? 0
            : sorted.length - 1
          : Math.max(
              0,
              Math.min(
                sorted.length - 1,
                idx + dir,
              ),
            );

      const nextSession =
        sorted[nextIdx];

      const nextId =
        nextSession?.id ?? null;

      if (nextSession) {
        selectedAnchorRef.current =
          nextSession.eventIds[0] ?? null;

        selectedSessionRef.current =
          nextSession;
      }

      selectedIdRef.current = nextId;
      setSelectedId(nextId);
    },

    onClearSelection: () => {
      selectedAnchorRef.current = null;
      selectedSessionRef.current = null;
      selectedIdRef.current = null;
      setSelectedId(null);
    },
  });

  // ── date navigation ────────────────────────────────────────────────────────

  const prevDate = useCallback(() => {
    const d = new Date(day);

    if (view === 'day') {
      d.setDate(d.getDate() - 1);
    } else if (view === 'week') {
      d.setDate(d.getDate() - 7);
    } else if (view === 'month') {
      d.setMonth(d.getMonth() - 1);
    } else if (view === 'year') {
      d.setFullYear(
        d.getFullYear() - 1,
      );
    }

    setDay(startOfDay(d));
  }, [day, view]);

  const nextDate = useCallback(() => {
    const d = new Date(day);

    if (view === 'day') {
      d.setDate(d.getDate() + 1);
    } else if (view === 'week') {
      d.setDate(d.getDate() + 7);
    } else if (view === 'month') {
      d.setMonth(d.getMonth() + 1);
    } else if (view === 'year') {
      d.setFullYear(
        d.getFullYear() + 1,
      );
    }

    setDay(startOfDay(d));
  }, [day, view]);

  const goToday = useCallback(
    () => setDay(startOfDay(new Date())),
    [],
  );

  const pickDay = useCallback(
    (dateStr: string) => {
      const d = new Date(
        dateStr + 'T00:00:00',
      );

      if (!Number.isNaN(d.getTime())) {
        setDay(startOfDay(d));
      }
    },
    [],
  );

  // ── resize divider drag ───────────────────────────────────────────────────

  const onDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      const container =
        workspaceRef.current;

      if (!container) return;

      const rect =
        container.getBoundingClientRect();

      function move(ev: MouseEvent) {
        onDrag(
          ev.clientX,
          rect.left,
          rect.width,
        );
      }

      function up() {
        window.removeEventListener(
          'mousemove',
          move,
        );

        window.removeEventListener(
          'mouseup',
          up,
        );

        document.body.style.cursor = '';
      }

      document.body.style.cursor =
        'col-resize';

      window.addEventListener(
        'mousemove',
        move,
      );

      window.addEventListener(
        'mouseup',
        up,
      );
    },
    [onDrag],
  );

  const onCreateOfflineAt = useCallback(
    (time: Date, x: number, y: number) => {
      if (!readOnly) {
        const snappedStart =
          snapTime(time);

        const snappedEnd =
          new Date(
            snappedStart.getTime() +
              60 * 60_000,
          );

        setOfflinePopover({
          x: Math.min(
            x,
            window.innerWidth - 300,
          ),
          y: Math.min(
            y,
            window.innerHeight - 260,
          ),
          startedAt: snappedStart,
          endedAt: snappedEnd,
        });
      }
    },
    [readOnly],
  );

  const inspectorActions: InspectorActions = {
    onRename,
    onSplit,
    onMerge,
    onDuplicate,
    onDelete,
    onToggleOffline,
    onNoteChange,
    onCopyDetails,
    onAssignActivity,
    onUpdateActivity,
    onNavigateToRule,
    onCreateRuleFromSession,

    onClassifySession: async (
      eventIds,
      classification,
      sessionHint,
    ) => {
      try {
        await window.categorization.saveOverride(
          {
            eventIds,
            ...classification,
            sessionHint,
          },
        );

        await refresh();
      } catch (e) {
        console.error(
          'Failed to save classification override',
          e,
        );
      }
    },
  };

  const ctxSession =
    contextMenu?.session ?? null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <TimelineToolbar
        view={view}
        onViewChange={setView}
        dayLabel={dayLabel}
        onPrevDay={prevDate}
        onNextDay={nextDate}
        onPickDay={pickDay}
        onToday={goToday}
        isToday={
          isToday && view === 'day'
        }
        canUndo={canUndo}
        canRedo={canRedo}
        activeEdits={activeEdits}
        onUndo={undo}
        onRedo={redo}
        onInsertOffline={() =>
          setOfflinePopover({
            x:
              window.innerWidth / 2 -
              130,
            y: 80,
          })
        }
        density={density}
        onDensityChange={changeDensity}
        customStart={customStart}
        customEnd={customEnd}
        onCustomStartChange={
          setCustomStart
        }
        onCustomEndChange={
          setCustomEnd
        }
      />

      <div
        ref={workspaceRef}
        style={{
          display: 'flex',
          flex: 1,
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: `0 0 ${timelinePct}%`,
            minWidth: 0,
            display: 'flex',
          }}
        >
          {view === 'day' && (
            <TimelineCanvas
              ref={canvasRef}
              baseDay={day}
              sessions={sessions}
              focusSessions={
                focusSessions
              }
              pxPerHour={pxPerHour}
              selectedId={selectedId}
              isToday={isToday}
              previewSession={preview}
              renameRequest={
                renameRequest
              }
              readonly={readOnly}
              onSelect={onSelect}
              onOpenFocus={
                onOpenFocus
              }
              onRename={onRename}
              onStartDrag={
                onStartDrag
              }
              onStartResize={
                onStartResize
              }
              onContextMenu={(
                e,
                session,
              ) => {
                e.preventDefault();

                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  session,
                });
              }}
              onCreateOfflineAt={
                onCreateOfflineAt
              }
            />
          )}

          {view === 'week' && (
            <WeekView
              baseDay={day}
              sessions={sessions}
              selectedId={selectedId}
              renameRequest={
                renameRequest
              }
              onSelect={onSelect}
              onRename={onRename}
              onOverrideEnvelope={
                onOverrideEnvelope
              }
              onContextMenu={(
                e,
                session,
              ) => {
                e.preventDefault();

                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  session,
                });
              }}
              onCreateOfflineAt={
                onCreateOfflineAt
              }
            />
          )}

          {view === 'month' && (
            <MonthView
              baseDay={day}
              sessions={sessions}
              onDrillDown={(
                targetDay,
              ) => {
                setDay(targetDay);
                setView('day');
              }}
            />
          )}

          {view === 'year' && (
            <YearView
              baseDay={day}
              sessions={sessions}
              onDrillDown={(
                targetMonthDay,
              ) => {
                setDay(targetMonthDay);
                setView('month');
              }}
            />
          )}

          {view === 'custom' && (
            <CustomView
              sessions={sessions}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          )}
        </div>

        <ResizeDivider
          onDragStart={onDividerDown}
        />

        <div
          style={{
            flex: 1,
            minWidth: 0,
          }}
        >
          <InspectorPanel
            sessions={sessions}
            focusSessions={
              focusSessions
            }
            selectedId={selectedId}
            isToday={!readOnly}
            dayLabel={dayLabel}
            actions={inspectorActions}
            view={view}
            onOpenFocus={
              onOpenFocus
            }
          />
        </div>
      </div>

      {contextMenu &&
        ctxSession && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            session={ctxSession}
            isToday={!readOnly}
            onRename={() => {
              selectedAnchorRef.current =
                ctxSession.eventIds[0] ??
                null;

              selectedSessionRef.current =
                ctxSession;

              selectedIdRef.current =
                ctxSession.id;

              setSelectedId(
                ctxSession.id,
              );

              setRenameRequest(
                (prev) => ({
                  id: ctxSession.id,
                  nonce:
                    (prev?.nonce ?? 0) +
                    1,
                }),
              );
            }}
            onSplit={() =>
              onSplit(ctxSession.id)
            }
            onMerge={() =>
              onMerge(ctxSession.id)
            }
            onDelete={() =>
              onDelete(ctxSession.id)
            }
            onDuplicate={() =>
              onDuplicate(
                ctxSession.id,
              )
            }
            onAddNote={(note) =>
              onNoteChange(
                ctxSession.id,
                note,
              )
            }
            onToggleOffline={(
              offline,
            ) =>
              onToggleOffline(
                ctxSession.id,
                offline,
              )
            }
            onCopyDetails={() =>
              onCopyDetails(
                ctxSession,
              )
            }
            onClose={() =>
              setContextMenu(null)
            }
          />
        )}

      {offlinePopover && (
        <TimeRangeSelector
          anchorX={
            offlinePopover.x
          }
          anchorY={
            offlinePopover.y
          }
          defaults={{
            startedAt:
              offlinePopover.startedAt ??
              defaultOfflineRange(
                day,
              ).startedAt,
            endedAt:
              offlinePopover.endedAt ??
              defaultOfflineRange(
                day,
              ).endedAt,
          }}
          onSubmit={submitOffline}
          onCancel={() =>
            setOfflinePopover(null)
          }
        />
      )}

      {toast && (
        <div style={toastStyle}>
          {toast}
        </div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function noopCommit(): void {
  // read-only drag/resize commit is a no-op
}

function getMonday(d: Date): Date {
  const date = new Date(d);
  const dayOfWeek = date.getDay();

  const diff =
    date.getDate() -
    dayOfWeek +
    (dayOfWeek === 0 ? -6 : 1);

  return startOfDay(
    new Date(date.setDate(diff)),
  );
}

function getDayLabel(
  day: Date,
  isToday: boolean,
  view: TimelineView,
  customStart: string,
  customEnd: string,
): string {
  const now = new Date();

  if (view === 'day') {
    const opts: Intl.DateTimeFormatOptions =
      {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      };

    const label =
      new Intl.DateTimeFormat(
        undefined,
        opts,
      ).format(day);

    return day.toDateString() ===
      now.toDateString()
      ? `${label} · Today`
      : label;
  }

  if (view === 'week') {
    const start = getMonday(day);

    const end = new Date(
      start.getTime() +
        6 * 24 * 3600 * 1000,
    );

    const opts: Intl.DateTimeFormatOptions =
      {
        month: 'short',
        day: 'numeric',
      };

    const startLbl =
      new Intl.DateTimeFormat(
        undefined,
        opts,
      ).format(start);

    const endLbl =
      new Intl.DateTimeFormat(
        undefined,
        opts,
      ).format(end);

    return `${startLbl} – ${endLbl}, ${start.getFullYear()}`;
  }

  if (view === 'month') {
    return day.toLocaleDateString(
      undefined,
      {
        month: 'long',
        year: 'numeric',
      },
    );
  }

  if (view === 'year') {
    return String(
      day.getFullYear(),
    );
  }

  // Custom view range label
  const start = new Date(
    customStart + 'T00:00:00',
  );

  const end = new Date(
    customEnd + 'T00:00:00',
  );

  const opts: Intl.DateTimeFormatOptions =
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    };

  const startLbl =
    new Intl.DateTimeFormat(
      undefined,
      opts,
    ).format(start);

  const endLbl =
    new Intl.DateTimeFormat(
      undefined,
      opts,
    ).format(end);

  return `${startLbl} – ${endLbl}`;
}

function defaultOfflineRange(
  base: Date,
): {
  startedAt: Date;
  endedAt: Date;
} {
  const pinnedIsToday =
    base.toDateString() ===
    new Date().toDateString();

  const end = pinnedIsToday
    ? new Date()
    : (() => {
        const e =
          startOfDay(base);

        e.setHours(
          18,
          0,
          0,
          0,
        );

        return e;
      })();

  const start = new Date(
    end.getTime() -
      30 * 60_000,
  );

  return {
    startedAt: start,
    endedAt: end,
  };
}

const toastStyle: React.CSSProperties =
  {
    position: 'fixed',
    bottom: 20,
    left: '50%',
    transform:
      'translateX(-50%)',
    zIndex: 2000,
    padding: '8px 16px',
    background:
      'var(--bg-elevated)',
    border:
      '1px solid var(--border-strong)',
    borderRadius:
      'var(--radius-md)',
    color: 'var(--text)',
    fontSize: '12.5px',
    boxShadow:
      'var(--shadow-md)',
  };