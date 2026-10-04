/**
 * A single activity block in the Day / Week timeline.
 *
 * Position and size come from `computeDayLayout`: `top` is the exact start,
 * `height` the drawn height (never into another block). What the block shows
 * follows from that height (`blockMode`):
 *   - marker  → a slim coloured bar; title and times on hover / click
 *   - line    → one line: Title · Duration
 *   - compact → Title, then Time · Duration
 *   - full    → the roomy card
 * Text is always single-line with an ellipsis and the block clips its content,
 * so a long title can never reach a neighbour.
 *
 * Visual design:
 *   - neutral calm fill; a left-edge bar keeps the deterministic app hue. When
 *     a short activity is drawn taller than its duration (to fit its label),
 *     the solid part of the bar still marks the real duration.
 *   - selected → accent border + elevation; offline → muted dashed style
 *   - resize handles on top/bottom (visible on hover/selection)
 *   - double-click → inline rename
 *
 * Drag & resize are driven by parent hooks via transform callbacks; the view
 * is presentational only (no mutations of its own).
 */
import { useEffect, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { InlineEditor } from './InlineEditor';
import { fmtDuration, fmtHm, sessionColorVar } from './timelineUtils';
import { blockMode, MIN_MARKER_HEIGHT } from './timelineLayout';

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
  /** Drawn height in px. */
  height: number;
  /** Exact duration in px; defaults to `height`. */
  trueHeight?: number;
  /** px, or any CSS length (the Day View positions lanes in percent). */
  width: number | string;
  left: number | string;
  /** Approximate width in px, to decide what fits beside the title. */
  widthPx?: number;
  isSelected: boolean;
  isPreview?: boolean;
  invalid?: boolean;
  readonly?: boolean;
  /** Whether this block is the timeline's tab stop. */
  tabbable?: boolean;
  renameRequestNonce?: number;
  actions: SessionBlockActions;
}

export interface SessionBlockViewProps extends Omit<SessionBlockProps, 'renameRequestNonce'> {
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}

const MEDIUM_THRESHOLD = 96;
const LARGE_THRESHOLD = 130;
/** Below this the top/bottom resize handles would cover the whole block. */
const RESIZE_MIN_HEIGHT = 24;
/** Room the inline rename field needs. */
const EDIT_MIN_HEIGHT = 28;
/** A line block shorter than this uses the small label size. */
const CHIP_TEXT_HEIGHT = 18;
/** A line block narrower than this shows the title only. */
const DURATION_MIN_WIDTH = 120;
/** A line block narrower than this cannot show a readable word: no text at all. */
const TEXT_MIN_WIDTH = 40;

/** Plain-text label: what the block is, for hover and assistive tech. */
export function sessionBlockLabel(session: VerifiedSessionDto): string {
  const title = session.title || (session.source === 'user' ? '(offline)' : '(unlabelled)');
  return `${title}, ${fmtHm(session.startedAt)} to ${fmtHm(session.endedAt)}, ${fmtDuration(session.duration)}`;
}

function sessionTooltip(session: VerifiedSessionDto): string {
  const isOffline = session.source === 'user';
  const classification = [session.classification?.context?.name, session.classification?.area?.name]
    .filter(Boolean)
    .join(' · ');
  return [
    session.title || (isOffline ? '(offline)' : '(unlabelled)'),
    `${fmtHm(session.startedAt)} – ${fmtHm(session.endedAt)} · ${fmtDuration(session.duration)}`,
    classification,
    `${session.eventCount} event${session.eventCount === 1 ? '' : 's'}`,
    'Click for details',
  ]
    .filter(Boolean)
    .join('\n');
}

export function SessionBlock({ renameRequestNonce, ...props }: SessionBlockProps) {
  const [editing, setEditing] = useState(false);
  const { readonly, isPreview } = props;

  useEffect(() => {
    if (renameRequestNonce !== undefined && !readonly && !isPreview) setEditing(true);
  }, [renameRequestNonce, readonly, isPreview]);

  return <SessionBlockView {...props} editing={editing} onEditingChange={setEditing} />;
}

export function SessionBlockView({
  session,
  top,
  height,
  trueHeight,
  width,
  left,
  widthPx,
  isSelected,
  isPreview,
  invalid,
  readonly,
  tabbable,
  editing,
  onEditingChange,
  actions,
}: SessionBlockViewProps) {
  const isOffline = session.source === 'user';
  const accent = invalid ? 'var(--danger)' : sessionColorVar(session);

  // While renaming, a slim block opens up enough for the text field.
  const drawnHeight = Math.max(MIN_MARKER_HEIGHT, editing ? Math.max(height, EDIT_MIN_HEIGHT) : height);
  const mode = blockMode(drawnHeight);
  // One pixel of air between a block and the one that starts where it ends.
  const boxHeight = drawnHeight - 1;
  const medium = drawnHeight >= MEDIUM_THRESHOLD;
  const large = drawnHeight >= LARGE_THRESHOLD;
  const canResize = !readonly && !isPreview && drawnHeight >= RESIZE_MIN_HEIGHT;

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
      ? accent
      : isOffline
        ? 'var(--block-offline-border)'
        : 'var(--block-neutral-border)';

  const borderStyle = isOffline && !isSelected && !invalid ? 'dashed' : 'solid';
  const title = session.title || (
    <em style={{ color: 'var(--text-faint)', fontWeight: 400 }}>{isOffline ? '(offline)' : '(unlabelled)'}</em>
  );

  const shared = {
    'data-session-id': session.id,
    'data-block-mode': mode,
    role: 'button',
    tabIndex: tabbable ? 0 : -1,
    'aria-label': sessionBlockLabel(session),
    'aria-pressed': isSelected,
    title: sessionTooltip(session),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      actions.onSelect(session.id);
    },
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!readonly) onEditingChange(true);
    },
    onMouseDown: (e: React.MouseEvent) => {
      if (e.button === 0 && !readonly) actions.onStartDrag(session.id, e);
    },
    onContextMenu: (e: React.MouseEvent) => actions.onContextMenu?.(e, session),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        actions.onSelect(session.id);
      }
    },
  };

  const frame: React.CSSProperties = {
    position: 'absolute',
    top,
    left,
    width: typeof width === 'number' ? Math.max(0, width - 4) : `calc(${width} - 4px)`, // spacing between lanes
    height: boxHeight,
    boxSizing: 'border-box',
    overflow: 'hidden',
    cursor: readonly ? 'default' : 'pointer',
    opacity: isPreview ? 0.92 : 1,
    zIndex: editing ? 30 : isPreview ? 20 : isSelected ? 10 : 2,
    userSelect: 'none',
    contain: 'layout paint',
  };

  if (mode === 'marker') {
    return (
      <div
        {...shared}
        className="session-marker animate-fadeIn"
        style={{
          ...frame,
          borderRadius: 2,
          background: isSelected || invalid ? accent : `color-mix(in srgb, ${accent} 58%, transparent)`,
          boxShadow: isSelected ? `0 0 0 1px var(--bg), 0 0 0 2px ${accent}` : 'none',
          transition: isPreview ? 'none' : 'background-color 130ms var(--ease-out), box-shadow 130ms var(--ease-out)',
        }}
      />
    );
  }

  const line = mode === 'line';
  const small = line && drawnHeight < CHIP_TEXT_HEIGHT;
  const accentWidth = line ? 3 : 5;
  const realHeight = trueHeight ?? drawnHeight;
  const grown = realHeight < drawnHeight - 1;
  const showText = !line || widthPx === undefined || widthPx >= TEXT_MIN_WIDTH;

  return (
    <div
      {...shared}
      className={`session-block${line ? ' session-block--slim' : ''} animate-fadeIn`}
      style={{
        ...frame,
        borderRadius: line ? 6 : 10,
        padding: line
          ? `0 8px 0 ${accentWidth + 7}px`
          : mode === 'compact'
            ? '4px 12px 4px 16px'
            : medium
              ? '12px 14px 12px 20px'
              : '10px 12px 10px 18px',
        background: fill,
        border: `1px ${borderStyle} ${borderColor}`,
        color: 'var(--text)',
        transition: isPreview
          ? 'none'
          : `box-shadow 130ms var(--ease-out), border-color 130ms var(--ease-out), background-color 130ms var(--ease-out), transform 130ms var(--ease-out)`,
        boxShadow: isSelected ? 'var(--shadow-md)' : 'none',
        display: 'flex',
        flexDirection: line ? 'row' : 'column',
        alignItems: line ? 'center' : undefined,
        justifyContent: mode === 'compact' ? 'center' : 'flex-start',
        gap: line ? 8 : undefined,
      }}
    >
      {/* Category/Accent bar inside the card border. On a block drawn taller
          than its duration, the solid part is the real duration. */}
      {grown && (
        <span
          aria-hidden
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: accentWidth, background: accent, opacity: 0.28 }}
        />
      )}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          width: accentWidth,
          height: grown ? Math.max(2, realHeight) : '100%',
          background: accent,
          opacity: 0.9,
        }}
      />

      {/* Resize handles — hidden in read-only mode, in preview, and on blocks
          too short to have a body between them. */}
      {canResize && (
        <>
          <div
            className="resize-handle-top"
            onMouseDown={(e) => { e.stopPropagation(); actions.onStartResize(session.id, 'top', e); }}
            style={{ position: 'absolute', top: -3, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 3, borderTop: '2px solid var(--block-selected-border)', opacity: isSelected ? 0.75 : 0, transition: 'opacity 100ms ease' }}
          />
          <div
            className="resize-handle-bottom"
            onMouseDown={(e) => { e.stopPropagation(); actions.onStartResize(session.id, 'bottom', e); }}
            style={{ position: 'absolute', bottom: -3, left: 10, right: 10, height: 6, cursor: 'ns-resize', zIndex: 3, borderBottom: '2px solid var(--block-selected-border)', opacity: isSelected ? 0.75 : 0, transition: 'opacity 100ms ease' }}
          />
        </>
      )}

      {/* Title — first line, medium weight. */}
      {editing ? (
        <InlineEditor
          initial={session.title}
          onCommit={(v) => { onEditingChange(false); actions.onRename(session.id, v); }}
          onCancel={() => onEditingChange(false)}
          className={mode === 'full' ? undefined : 'text-[11.5px]'}
        />
      ) : !showText ? null : (
        <div
          style={{
            fontSize: line ? (small ? '10.5px' : '12px') : mode === 'compact' ? '13px' : medium ? '15.5px' : '14px',
            fontWeight: line ? 650 : 700,
            lineHeight: line ? `${boxHeight - 2}px` : 1.2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: line ? '1 1 auto' : undefined,
          }}
        >
          {title}
        </div>
      )}

      {/* Subtitles: Adaptive layout depending on height */}
      {!editing && line && (widthPx === undefined || widthPx >= DURATION_MIN_WIDTH) && (
        <div style={{ fontSize: '10.5px', color: 'var(--text-faint)', fontWeight: 500, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {fmtDuration(session.duration)}
        </div>
      )}
      {!editing && !line && (
        <>
          {large ? (
            <>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: 6, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {fmtHm(session.startedAt)} – {fmtHm(session.endedAt)}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginTop: 4, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {fmtDuration(session.duration)}
              </div>
            </>
          ) : (
            <div style={{ fontSize: mode === 'compact' ? '11px' : '11.5px', color: 'var(--text-muted)', marginTop: mode === 'compact' ? 2 : 4, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {fmtHm(session.startedAt)} – {fmtHm(session.endedAt)} · {fmtDuration(session.duration)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

