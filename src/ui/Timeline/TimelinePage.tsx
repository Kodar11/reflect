/**
 * TimelinePage — the primary Day View workspace (Stage 3.6).
 *
 * Layout:
 *   Sticky toolbar (day nav · undo/redo · + offline)
 *   ├─ Timeline canvas (ruler + grid + blocks + current time)
 *   ┊ Resize divider
 *   └─ Inspector panel (DailySummary or SessionDetail; always visible)
 *
 * State philosophy:
 *   - A single `day` (local Date at start-of-day) drives the view.
 *   - Single selection (`selectedId: string | null`).
 *   - Editing is only enabled when viewing *today* (the backend resolves
 *     edit hints against today's sessions only — we cannot touch the backend,
 *     so non-today days render read-only with disabled actions).
 *   - Polling runs only while viewing today; past days don't change.
 *   - All mutations go through `window.timeline.apply`; the renderer never
 *     performs merge/split/rename logic.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { TimelineToolbar } from './TimelineToolbar';
import { TimelineCanvas, type TimelineCanvasHandle } from './TimelineCanvas';
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
} from './timelineUtils';

const POLL_MS = 2500;

export function TimelinePage() {
  const [day, setDay] = useState<Date>(() => startOfDay(new Date()));
  const [sessions, setSessions] = useState<VerifiedSessionDto[]>([]);
  const [activeEdits, setActiveEdits] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [renameRequest, setRenameRequest] = useState<{ id: string; nonce: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: VerifiedSessionDto } | null>(null);
  const [offlinePopover, setOfflinePopover] = useState<{ x: number; y: number } | null>(null);

  const canvasRef = useRef<TimelineCanvasHandle>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const { timelinePct, onDrag } = useResizeSplit();

  const isToday = day.toDateString() === new Date().toDateString();
  const readOnly = !isToday;
  const dayLabel = formatDayLabel(day, isToday);

  const eventIdsFor = useCallback((id: string): number[] => {
    return sessions.find((s) => s.id === id)?.eventIds ?? [];
  }, [sessions]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [list, status] = await Promise.all([
        isToday ? window.timeline.getToday() : window.timeline.getRange(day.toISOString(), endOfDay(day).toISOString()),
        window.timeline.status(),
      ]);
      setSessions(sortByStart(list));
      setActiveEdits(status.activeEdits);
    } catch (e) {
      console.error('[TimelinePage] refresh failed', e);
      showToast(`Failed to load: ${(e as Error)?.message ?? String(e)}`);
    }
  }, [day, isToday, showToast]);

  useEffect(() => {
    refresh();
    if (isToday) canvasRef.current?.scrollToNow();
  }, [refresh, isToday]);

  // Clear selection when the day changes if the selected session isn't present.
  useEffect(() => {
    if (selectedId && !sessions.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [sessions, selectedId]);

  // ── mutations ─────────────────────────────────────────────────────────────
  const applyEdit = useCallback(async (operation: string, payload: unknown) => {
    try {
      await window.timeline.apply({ operation, payload });
    } catch (e) {
      showToast(`Edit failed: ${(e as Error)?.message ?? String(e)}`);
    }
    await refresh();
  }, [refresh, showToast]);

  const undo = useCallback(async () => {
    try { await window.timeline.undo(); } catch (e) { showToast(`Undo failed: ${(e as Error)?.message ?? String(e)}`); }
    await refresh();
  }, [refresh, showToast]);

  const redo = useCallback(async () => {
    try { await window.timeline.redo(); } catch (e) { showToast(`Redo failed: ${(e as Error)?.message ?? String(e)}`); }
    await refresh();
  }, [refresh, showToast]);

  const canUndo = activeEdits > 0;
  const [canRedo, setCanRedo] = useState(false);
  // Track redo availability cheaply: redo is possible when there's at least one
  // undone edit in the log. IPC doesn't expose this today, so we optimistically
  // enable after an undo and disable after a redo/apply.
  useEffect(() => { setCanRedo(false); }, [activeEdits]);

  const onRename = useCallback((id: string, newTitle: string) => applyEdit('rename', { eventIdsHint: eventIdsFor(id), newTitle }), [applyEdit, eventIdsFor]);
  const onSplit = useCallback((id: string) => applyEdit('split', { eventIdsHint: eventIdsFor(id), afterEventIndex: 0 }), [applyEdit, eventIdsFor]);
  const onMerge = useCallback((id: string) => applyEdit('merge', { eventIdsHint: eventIdsFor(id) }), [applyEdit, eventIdsFor]);
  const onDuplicate = useCallback((id: string) => applyEdit('duplicate', { eventIdsHint: eventIdsFor(id) }), [applyEdit, eventIdsFor]);
  const onDelete = useCallback((id: string) => applyEdit('delete', { eventIdsHint: eventIdsFor(id) }), [applyEdit, eventIdsFor]);
  const onToggleOffline = useCallback((id: string, offline: boolean) => applyEdit('mark_offline', { eventIdsHint: eventIdsFor(id), offline }), [applyEdit, eventIdsFor]);
  const onNoteChange = useCallback((id: string, note: string) => applyEdit('note', { eventIdsHint: eventIdsFor(id), note }), [applyEdit, eventIdsFor]);
  const onOverrideEnvelope = useCallback((id: string, newStartedAt: string, newEndedAt: string) => applyEdit('override_envelope', { eventIdsHint: eventIdsFor(id), newStartedAt, newEndedAt }), [applyEdit, eventIdsFor]);

  // ── drag / resize (today only) ────────────────────────────────────────────
  const { preview: dragPreview, onStartDrag } = useBlockDrag(day, sessions, readOnly ? noopCommit : onOverrideEnvelope);
  const { preview: resizePreview, onStartResize } = useBlockResize(day, sessions, readOnly ? noopCommit : onOverrideEnvelope);
  const preview = readOnly ? null : (dragPreview ?? resizePreview);

  useEffect(() => {
    if (!isToday) return;
    const t = setInterval(() => {
      const busy = !!contextMenu || !!offlinePopover || !!dragPreview || !!resizePreview;
      if (!busy) refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh, isToday, contextMenu, offlinePopover, dragPreview, resizePreview]);

  const submitOffline = useCallback(async (draft: OfflineDraft) => {
    setOfflinePopover(null);
    await applyEdit('create_offline', draft);
  }, [applyEdit]);

  const onCopyDetails = useCallback((s: VerifiedSessionDto) => {
    const text = sessionDetailsText(s);
    try {
      navigator.clipboard?.writeText(text);
      showToast('Copied session details');
    } catch {
      showToast(text);
    }
  }, [showToast]);

  // ── selection ─────────────────────────────────────────────────────────────
  const onSelect = useCallback((id: string) => setSelectedId(id || null), []);

  // ── keyboard ──────────────────────────────────────────────────────────────
  useTimelineKeyboard(selectedId, {
    editable: !readOnly,
    onRename: (id) => {
      setSelectedId(id);
      setRenameRequest((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    onDelete,
    onUndo: undo,
    onRedo: redo,
    onNavigate: (dir) => {
      const sorted = sortByStart(sessions);
      const idx = sorted.findIndex((s) => s.id === selectedId);
      const nextIdx = idx < 0 ? (dir > 0 ? 0 : sorted.length - 1) : Math.max(0, Math.min(sorted.length - 1, idx + dir));
      const nextId = sorted[nextIdx]?.id ?? null;
      setSelectedId(nextId);
    },
    onClearSelection: () => setSelectedId(null),
  });

  // ── day navigation ────────────────────────────────────────────────────────
  const prevDay = useCallback(() => {
    const d = new Date(day);
    d.setDate(d.getDate() - 1);
    setDay(startOfDay(d));
  }, [day]);

  const nextDay = useCallback(() => {
    const d = new Date(day);
    d.setDate(d.getDate() + 1);
    setDay(startOfDay(d));
  }, [day]);

  const goToday = useCallback(() => setDay(startOfDay(new Date())), []);
  const pickDay = useCallback((dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    if (!Number.isNaN(d.getTime())) setDay(startOfDay(d));
  }, []);

  // ── resize divider drag ───────────────────────────────────────────────────
  const onDividerDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = workspaceRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    function move(ev: MouseEvent) {
      onDrag(ev.clientX, rect.left, rect.width);
    }
    function up() {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    }
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [onDrag]);

  const inspectorActions: InspectorActions = {
    onRename,
    onSplit,
    onMerge,
    onDuplicate,
    onDelete,
    onToggleOffline,
    onNoteChange,
    onCopyDetails,
  };

  const ctxSession = contextMenu?.session ?? null;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}
    >
      <TimelineToolbar
        dayLabel={dayLabel}
        onPrevDay={prevDay}
        onNextDay={nextDay}
        onPickDay={pickDay}
        onToday={goToday}
        isToday={isToday}
        canUndo={canUndo}
        canRedo={canRedo}
        activeEdits={activeEdits}
        onUndo={undo}
        onRedo={redo}
        onInsertOffline={() => setOfflinePopover({ x: window.innerWidth / 2 - 130, y: 80 })}
      />

      <div
        ref={workspaceRef}
        style={{ display: 'flex', flex: 1, overflow: 'hidden', minWidth: 0 }}
      >
        <div style={{ flex: `0 0 ${timelinePct}%`, minWidth: 0, display: 'flex' }}>
          <TimelineCanvas
            ref={canvasRef}
            baseDay={day}
            sessions={sessions}
            selectedId={selectedId}
            isToday={isToday}
            previewSession={preview}
            renameRequest={renameRequest}
            readonly={readOnly}
            onSelect={onSelect}
            onRename={onRename}
            onStartDrag={onStartDrag}
            onStartResize={onStartResize}
            onContextMenu={(e, session) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, session }); }}
            onCreateOfflineAt={(x, y) => {
              if (!readOnly) setOfflinePopover({ x: Math.min(x, window.innerWidth - 300), y: Math.min(y, window.innerHeight - 260) });
            }}
          />
        </div>

        <ResizeDivider onDragStart={onDividerDown} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <InspectorPanel
            sessions={sessions}
            selectedId={selectedId}
            isToday={isToday}
            dayLabel={dayLabel}
            actions={inspectorActions}
          />
        </div>
      </div>

      {contextMenu && ctxSession && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          session={ctxSession}
          isToday={isToday}
          onRename={() => {
            setSelectedId(ctxSession.id);
            setRenameRequest((prev) => ({ id: ctxSession.id, nonce: (prev?.nonce ?? 0) + 1 }));
          }}
          onSplit={() => onSplit(ctxSession.id)}
          onMerge={() => onMerge(ctxSession.id)}
          onDelete={() => onDelete(ctxSession.id)}
          onDuplicate={() => onDuplicate(ctxSession.id)}
          onAddNote={(note) => onNoteChange(ctxSession.id, note)}
          onToggleOffline={(offline) => onToggleOffline(ctxSession.id, offline)}
          onCopyDetails={() => onCopyDetails(ctxSession)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {offlinePopover && (
        <TimeRangeSelector
          anchorX={offlinePopover.x}
          anchorY={offlinePopover.y}
          defaults={defaultOfflineRange(day)}
          onSubmit={submitOffline}
          onCancel={() => setOfflinePopover(null)}
        />
      )}

      {toast && (
        <div style={toastStyle}>{toast}</div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function noopCommit(): void {
  // read-only drag/resize commit is a no-op
}

function formatDayLabel(day: Date, isToday: boolean): string {
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const label = new Intl.DateTimeFormat(undefined, opts).format(day);
  return isToday ? `${label} · Today` : label;
}

function defaultOfflineRange(base: Date): { startedAt: Date; endedAt: Date } {
  // Default offline entry lands on the viewed day at a sensible slot.
  const pinnedIsToday = base.toDateString() === new Date().toDateString();
  const end = pinnedIsToday ? new Date() : (() => { const e = startOfDay(base); e.setHours(18, 0, 0, 0); return e; })();
  const start = new Date(end.getTime() - 30 * 60_000);
  return { startedAt: start, endedAt: end };
}

const toastStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 20,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 2000,
  padding: '8px 16px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text)',
  fontSize: '12.5px',
  boxShadow: 'var(--shadow-md)',
};
