/**
 * A single session block in the Day View timeline.
 *
 * Visual design (Stage 3.6):
 *   - height ∝ duration (respects a min height so short sessions stay readable)
 *   - neutral calm fill; a thin left-edge bar keeps the deterministic app hue
 *   - content is intentionally minimal: Title · Time · Duration — nothing more
 *   - selected → accent border + elevation; offline → muted dashed style
 *   - resize handles on top/bottom (visible on hover/selection)
 *   - double-click title → inline rename
 *   - compact mode for tiny sessions (< 50 px): Title · Duration only
 *
 * Drag & resize are driven by parent hooks via transform callbacks; this
 * component is presentational only (no mutations of its own).
 */
import { useEffect, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { InlineEditor } from './InlineEditor';
import {
  fmtDuration,
  fmtHm,
  sessionColorVar,
  MIN_BLOCK_HEIGHT,
} from './timelineUtils';

export interface SessionBlockActions {
  onSelect: (id: string) => void;
  onRename: (id: string, newTitle: string) => void;
  onStartDrag: (id: string, e: React.MouseEvent) => void;
  onStartResize: (id: string, edge: 'top' | 'bottom', e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent, session: VerifiedSessionDto) => void;
}

interface SessionBlockProps {
  session: VerifiedSessionDto;
  top: number;
  height: number;
  width: number;
  left: number;
  isSelected: boolean;
  isPreview?: boolean;
  invalid?: boolean;
  readonly?: boolean;
  renameRequestNonce?: number;
  actions: SessionBlockActions;
}

const TINY_THRESHOLD = 52;
const MEDIUM_THRESHOLD = 72;
const LARGE_THRESHOLD = 108;

export function SessionBlock({
  session,
  top,
  height,
  width,
  left,
  isSelected,
  isPreview,
  invalid,
  readonly,
  renameRequestNonce,
  actions,
}: SessionBlockProps) {
  const [editing, setEditing] = useState(false);
  const isOffline = session.source === 'user';
  const accent = sessionColorVar(session);
  const visualHeight = Math.max(MIN_BLOCK_HEIGHT, height);
  const tiny = visualHeight < TINY_THRESHOLD;
  const medium = visualHeight >= MEDIUM_THRESHOLD;
  const large = visualHeight >= LARGE_THRESHOLD;

  useEffect(() => {
    if (renameRequestNonce !== undefined && !readonly && !isPreview) setEditing(true);
  }, [renameRequestNonce, readonly, isPreview]);

  const fill = invalid
    ? 'var(--danger-soft)'
    : isOffline
      ? 'var(--block-offline)'
      : isSelected
        ? 'var(--block-selected)'
        : 'var(--block-neutral)';

  const borderColor = invalid
    ? 'var(--danger)'
    : isSelected
      ? 'var(--block-selected-border)'
      : isOffline
        ? 'var(--block-offline-border)'
        : 'var(--block-neutral-border)';

  const borderStyle = isOffline && !isSelected && !invalid ? 'dashed' : 'solid';

  const tooltip = [
    session.title || (isOffline ? '(offline)' : '(unlabelled)'),
    fmtDuration(session.duration),
    `${session.eventCount} event${session.eventCount === 1 ? '' : 's'}`,
    'Click for details',
  ].join('\n');

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        actions.onSelect(session.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!readonly) setEditing(true);
      }}
      onMouseDown={(e) => {
        if (e.button === 0 && !readonly) actions.onStartDrag(session.id, e);
      }}
      onContextMenu={(e) => actions.onContextMenu?.(e, session)}
      title={tooltip}
      className="session-block"
      style={{
        position: 'absolute',
        top,
        left,
        width,
        height: visualHeight,
        borderRadius: 8,
        padding: tiny ? '6px 10px 6px 13px' : medium ? '9px 12px 9px 14px' : '7px 11px 7px 13px',
        background: fill,
        border: `1px ${borderStyle} ${borderColor}`,
        borderLeft: `${invalid || isSelected ? '1px' : 'var(--block-accent-w)'} solid ${invalid ? 'var(--danger)' : isSelected ? 'var(--block-selected-border)' : accent}`,
        color: 'var(--text)',
        overflow: 'hidden',
        cursor: readonly ? 'default' : 'pointer',
        opacity: isPreview ? 0.92 : 1,
        transition: isPreview
          ? 'none'
          : `box-shadow 130ms var(--ease-out), border-color 130ms var(--ease-out), background-color 130ms var(--ease-out), transform 130ms var(--ease-out)`,
        zIndex: isSelected ? 10 : isPreview ? 20 : 2,
        boxShadow: isSelected ? 'var(--shadow-md)' : 'none',
        userSelect: 'none',
        contain: 'layout paint',
      }}
    >
      {/* Rotate the accent bar to be its own left-edge element when neutral. */}
      {!isSelected && !invalid && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            background: accent,
            opacity: 0.55,
          }}
        />
      )}

      {/* Resize handles — hidden in read-only mode and in preview. */}
      {!readonly && !isPreview && (
        <>
          <div
            className="resize-handle-top"
            onMouseDown={(e) => { e.stopPropagation(); actions.onStartResize(session.id, 'top', e); }}
            style={{ position: 'absolute', top: -3, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 3, borderTop: '2px solid var(--block-selected-border)', opacity: isSelected ? 0.65 : 0 }}
          />
          <div
            className="resize-handle-bottom"
            onMouseDown={(e) => { e.stopPropagation(); actions.onStartResize(session.id, 'bottom', e); }}
            style={{ position: 'absolute', bottom: -3, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 3, borderBottom: '2px solid var(--block-selected-border)', opacity: isSelected ? 0.65 : 0 }}
          />
        </>
      )}

      {/* Title — first line, medium weight. */}
      {editing ? (
        <InlineEditor
          initial={session.title}
          onCommit={(v) => { setEditing(false); actions.onRename(session.id, v); }}
          onCancel={() => setEditing(false)}
          className={tiny ? 'text-[11px]' : undefined}
        />
      ) : (
        <div
          style={{
            fontSize: tiny ? '12.5px' : medium ? '14px' : '13px',
            fontWeight: 650,
            lineHeight: tiny ? '30px' : 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {session.title || <em style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{isOffline ? '(offline)' : '(unlabelled)'}</em>}
        </div>
      )}

      {medium && !editing && (
        <div style={{ fontSize: large ? '11.5px' : '11px', color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.25, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {large ? `${fmtHm(session.startedAt)}-${fmtHm(session.endedAt)}` : fmtDuration(session.duration)}
        </div>
      )}

      {large && !editing && (
        <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 4, lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {fmtDuration(session.duration)}
        </div>
      )}
    </div>
  );
}
