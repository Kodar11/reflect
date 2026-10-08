import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { EyeOff, MoreHorizontal, Trash2 } from 'lucide-react';
import { useDialog } from '../Focus/useDialog';

/**
 * The user's control over one captured event, shared by the Events view and
 * the Timeline inspector:
 *
 *   Hide event            immediate, with a short "Undo"
 *   Delete permanently…   behind a confirmation — it cannot be undone
 *
 * The event leaves the current view at once (`removedIds`); activities and
 * reflections that were written from it are brought up to date in the
 * background, and the toast says so.
 */

export const DELETE_EVENT_WARNING =
  'This permanently removes this tracked event and may change your timeline, activities, and reflections.';

/**
 * The menu, the toast and the dialog are fixed to the window. Rendered at the
 * document root so no scrolling, clipped or animated ancestor can move them.
 */
const atRoot = (node: ReactNode): ReactNode => (typeof document === 'undefined' ? null : createPortal(node, document.body));

/** How long "Undo" stays on offer after hiding. */
const UNDO_MS = 7_000;
const NOTICE_MS = 3_500;

export interface EventPrivacyTarget {
  id: number;
  /** What the event was, for the confirmation — e.g. `Chrome · Inbox`. */
  label?: string;
}

export type EventPrivacyNotice =
  | { kind: 'hidden'; eventIds: number[]; updating: boolean }
  | { kind: 'restored' | 'deleted'; updating: boolean }
  | { kind: 'error'; message: string };

/** The toast line for a notice. */
export function eventPrivacyMessage(notice: EventPrivacyNotice): string {
  if (notice.kind === 'error') return notice.message;
  const what = notice.kind === 'hidden' ? 'Event hidden' : notice.kind === 'restored' ? 'Event restored' : 'Event deleted';
  return notice.updating ? `${what} · Updating your timeline…` : what;
}

/** `events` without the ones the user just hid or deleted — before the next refresh confirms it. */
export function withoutRemoved<T extends { id: number }>(events: T[], removedIds: ReadonlySet<number>): T[] {
  return removedIds.size === 0 ? events : events.filter((e) => !removedIds.has(e.id));
}

export interface EventPrivacyControls {
  hide: (target: EventPrivacyTarget) => void;
  /** Opens the confirmation; nothing is deleted until it is confirmed. */
  requestDelete: (target: EventPrivacyTarget) => void;
  restore: (eventIds: number[]) => void;
  /** Events removed here that a parent list may still be holding. */
  removedIds: ReadonlySet<number>;
  /** The toast and the confirmation dialog; render once, anywhere. */
  overlay: ReactNode;
}

/** Which events a completed hide / restore / delete was about. */
export interface EventPrivacyChange {
  eventIds: number[];
  /** True when they were hidden or deleted; false when they were restored. */
  removed: boolean;
}

export function useEventPrivacy(options: { onChanged?: (change: EventPrivacyChange) => void } = {}): EventPrivacyControls {
  const [notice, setNotice] = useState<EventPrivacyNotice | null>(null);
  const [confirming, setConfirming] = useState<EventPrivacyTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [removedIds, setRemovedIds] = useState<ReadonlySet<number>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changed = useRef(options.onChanged);
  changed.current = options.onChanged;

  const show = useCallback((next: EventPrivacyNotice) => {
    if (timer.current) clearTimeout(timer.current);
    setNotice(next);
    timer.current = setTimeout(() => setNotice(null), next.kind === 'hidden' ? UNDO_MS : NOTICE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const markRemoved = useCallback((ids: number[], removed: boolean) => {
    setRemovedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (removed) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const run = useCallback(
    async (ids: number[], request: () => Promise<EventVisibilityResultDto>, done: (result: { updating: boolean }) => EventPrivacyNotice, removes: boolean) => {
      // Out of view first; a refusal puts it back.
      markRemoved(ids, removes);
      try {
        const result = await request();
        if (!result.ok) {
          markRemoved(ids, !removes);
          show({ kind: 'error', message: result.error });
          return;
        }
        show(done(result));
        changed.current?.({ eventIds: ids, removed: removes });
      } catch {
        markRemoved(ids, !removes);
        show({ kind: 'error', message: 'That change could not be saved. Nothing was changed.' });
      }
    },
    [markRemoved, show],
  );

  const hide = useCallback(
    (target: EventPrivacyTarget) =>
      void run([target.id], () => window.tracker.hideEvents([target.id]), ({ updating }) => ({ kind: 'hidden', eventIds: [target.id], updating }), true),
    [run],
  );

  const restore = useCallback(
    (eventIds: number[]) => void run(eventIds, () => window.tracker.unhideEvents(eventIds), ({ updating }) => ({ kind: 'restored', updating }), false),
    [run],
  );

  const confirmDelete = useCallback(async () => {
    if (!confirming) return;
    setBusy(true);
    try {
      await run([confirming.id], () => window.tracker.deleteEvents([confirming.id]), ({ updating }) => ({ kind: 'deleted', updating }), true);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }, [confirming, run]);

  const overlay = atRoot(
    <>
      {confirming && <DeleteEventDialog target={confirming} busy={busy} onCancel={() => !busy && setConfirming(null)} onConfirm={() => void confirmDelete()} />}
      {notice && <EventPrivacyToast notice={notice} onUndo={notice.kind === 'hidden' ? () => restore(notice.eventIds) : undefined} />}
    </>,
  );

  return { hide, requestDelete: setConfirming, restore, removedIds, overlay };
}

// ── Menu ────────────────────────────────────────────────────────────────────

/** The "⋯" button on an event row. */
export function EventPrivacyMenu({ onHide, onDelete, size = 13 }: { onHide: () => void; onDelete: () => void; size?: number }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost p-1"
        title="More"
        aria-label="More actions for this event"
        aria-haspopup="menu"
        aria-expanded={position !== null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setPosition(position ? null : { top: rect.bottom + 4, left: rect.right - MENU_WIDTH });
        }}
      >
        <MoreHorizontal size={size} />
      </button>
      {position && <EventPrivacyPopover top={position.top} left={position.left} onHide={onHide} onDelete={onDelete} onClose={() => setPosition(null)} />}
    </>
  );
}

/**
 * The same two choices as a context menu, opened where the pointer is —
 * so an event can be hidden from anywhere on its row.
 */
export function EventPrivacyContextMenu({ x, y, onHide, onDelete, onClose }: { x: number; y: number; onHide: () => void; onDelete: () => void; onClose: () => void }) {
  return <EventPrivacyPopover top={y} left={x} onHide={onHide} onDelete={onDelete} onClose={onClose} />;
}

function EventPrivacyPopover({ top, left, onHide, onDelete, onClose }: { top: number; left: number; onHide: () => void; onDelete: () => void; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    // The menu is fixed to where it was opened; a scroll would leave it behind.
    const onScroll = () => close.current();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  const choose = (action: () => void) => () => {
    onClose();
    action();
  };

  return atRoot(
    <div ref={menuRef} role="menu" style={{ ...menuStyle, ...withinWindow(top, left) }}>
      <EventPrivacyMenuItems onHide={choose(onHide)} onDelete={choose(onDelete)} />
    </div>,
  );
}

/** Keep the whole menu on screen, wherever it was asked for. */
function withinWindow(top: number, left: number): { top: number; left: number } {
  return {
    top: Math.max(8, Math.min(top, window.innerHeight - MENU_HEIGHT - 8)),
    left: Math.max(8, Math.min(left, window.innerWidth - MENU_WIDTH - 8)),
  };
}

/** The two choices, in the order they should be reached for. */
export function EventPrivacyMenuItems({ onHide, onDelete }: { onHide: () => void; onDelete: () => void }) {
  return (
    <>
      <button type="button" role="menuitem" style={menuItemStyle} className="hover:bg-hover" onClick={onHide}>
        <EyeOff size={13} />
        <span>Hide event</span>
      </button>
      <button type="button" role="menuitem" style={{ ...menuItemStyle, color: 'var(--danger)' }} className="hover:bg-hover" onClick={onDelete}>
        <Trash2 size={13} />
        <span>Delete permanently…</span>
      </button>
    </>
  );
}

// ── Confirmation ────────────────────────────────────────────────────────────

export interface DeleteEventDialogViewProps {
  target: EventPrivacyTarget;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  dialogRef?: RefObject<HTMLDivElement>;
  cancelRef?: RefObject<HTMLButtonElement>;
}

/** Keeping the event is the primary action; deleting takes the deliberate click. */
export function DeleteEventDialogView({ target, busy, onCancel, onConfirm, dialogRef, cancelRef }: DeleteEventDialogViewProps) {
  return (
    <div
      className="focus-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} className="focus-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-event-title" aria-describedby="delete-event-body">
        <div>
          <div id="delete-event-title" className="focus-dialog-title">
            Delete this event permanently?
          </div>
          {target.label && (
            <div className="focus-meta" style={{ marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={target.label}>
              {target.label}
            </div>
          )}
        </div>
        <div id="delete-event-body" className="focus-dialog-body">
          <p style={{ marginTop: 0 }}>{DELETE_EVENT_WARNING}</p>
          <p style={{ marginTop: 4 }}>
            <strong>This cannot be undone.</strong> To take it out of view and keep the option of restoring it, hide it instead.
          </p>
        </div>
        <div className="focus-actions">
          <button ref={cancelRef} type="button" className="focus-btn" data-variant="primary" onClick={onCancel} disabled={busy}>
            Keep event
          </button>
          <button type="button" className="focus-btn" data-variant="danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DeleteEventDialog(props: Omit<DeleteEventDialogViewProps, 'dialogRef' | 'cancelRef'>) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialog(dialogRef, props.onCancel);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return <DeleteEventDialogView {...props} dialogRef={dialogRef} cancelRef={cancelRef} />;
}

// ── Toast ───────────────────────────────────────────────────────────────────

export function EventPrivacyToast({ notice, onUndo }: { notice: EventPrivacyNotice; onUndo?: () => void }) {
  return (
    <div role="status" aria-live="polite" style={toastStyle}>
      <span>{eventPrivacyMessage(notice)}</span>
      {onUndo && (
        <button type="button" onClick={onUndo} style={undoStyle}>
          Undo
        </button>
      )}
    </div>
  );
}

const MENU_WIDTH = 196;
const MENU_HEIGHT = 76;

const menuStyle: React.CSSProperties = {
  position: 'fixed',
  zIndex: 1500,
  width: MENU_WIDTH,
  padding: 4,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-md)',
};

const menuItemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '7px 10px',
  borderRadius: 6,
  fontSize: '12.5px',
  fontWeight: 500,
  textAlign: 'left',
  color: 'var(--text)',
  cursor: 'pointer',
};

const toastStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 20,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 2000,
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  padding: '8px 16px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text)',
  fontSize: '12.5px',
  boxShadow: 'var(--shadow-md)',
};

const undoStyle: React.CSSProperties = {
  fontSize: '12.5px',
  fontWeight: 700,
  color: 'var(--accent)',
  cursor: 'pointer',
};
