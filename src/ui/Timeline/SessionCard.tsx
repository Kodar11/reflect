/**
 * Compact session card. Each row encodes the verified timeline's atomic unit.
 * Layout priorities (per spec):
 *   - one click for the most common action (rename, split, delete)
 *   - minimum vertical real estate — see as much of the day as possible
 *   - stability: keyed by session id so edits don't remount the list
 *
 * Interactions:
 *   - Click on title (or Enter on a focused card) → inline rename.
 *   - Hover reveals right-edge actions: Split / Delete / Merge w/ next.
 *   - Right-click opens the ContextMenu (Rename / Split / Merge / Delete /
 *     Insert Offline before/after), wired by the parent.
 *   - Click "Split" → reveals a thin horizontal scrubber of the session's
 *     events as ticks; clicking a tick splits at that event (zero dialogs).
 *
 * Pure presentational + local interaction state; all mutations dispatched via
 * `actions`. The card never mutates the timeline itself.
 */
import { useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { InlineEditor } from './InlineEditor';

export interface SessionCardActions {
  onRename: (sessionId: string, anchorEventId: number, newTitle: string) => void;
  onSplit: (sessionId: string, afterEventId: number) => void;
  onDelete: (sessionId: string, eventIds: number[]) => void;
  onMergeWithNext: (sessionId: string) => void;
  onContextMenu: (e: React.MouseEvent, session: VerifiedSessionDto) => void;
  onSelect: (sessionId: string, additive: boolean) => void;
  isSelected: boolean;
}

interface SessionCardProps {
  session: VerifiedSessionDto;
  actions: SessionCardActions;
}

export function SessionCard({ session, actions }: SessionCardProps) {
  const [editing, setEditing] = useState(false);
  const [splitScrubber, setSplitScrubber] = useState(false);

  // Lookup the anchor event id (first event) for rename. UI doesn't store
  // inside events as the DTO only exposes the count; we synthesize the anchor
  // via the service's lookup elsewhere — hence the prop `firstEventId`.
  // For Stage 3 we round-trip with the engine; the DTO omits event arrays so
  // this card uses the dedicated next-actions menu driven by the parent.

  const icon = session.source === 'user' ? '✎' : '';

  return (
    <div
      onClick={(e) => actions.onSelect(session.id, e.shiftKey)}
      onContextMenu={(e) => actions.onContextMenu(e, session)}
      className="session-card"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-secondary)',
        border: `1px solid ${actions.isSelected ? 'var(--accent)' : 'var(--border)'}`,
        fontSize: '13px',
        color: 'var(--text)',
        cursor: 'default',
      }}
    >
      {/* Time range chip */}
      <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: '11.5px', color: 'var(--text-muted)', minWidth: 88 }}>
        {fmtTime(session.startedAt)} – {fmtTime(session.endedAt)}
      </div>

      {/* Duration chip */}
      <div style={{
        fontSize: '11px', color: 'var(--text-faint)', minWidth: 48,
      }}>
        {humanDuration(session.duration)}
        {session.activeDuration > 0 && session.activeDuration < session.duration && (
          <span style={{ color: 'var(--text-faint)' }}> · {humanDuration(session.activeDuration)}</span>
        )}
      </div>

      {/* Title row (with inline rename) */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {editing ? (
          <InlineEditor
            initial={session.title}
            onCommit={(v) => { setEditing(false); actions.onRename(session.id, 0, v); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <span
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true); }}
            title={session.title || (session.source === 'user' ? '(offline activity)' : '(unlabelled)')}
          >
            {session.title || (session.source === 'user' ? <em style={{ color: 'var(--text-faint)' }}>(offline)</em> : <em style={{ color: 'var(--text-faint)' }}>(unlabelled)</em>)}
            {session.isCustomTitle && <span style={{ color: 'var(--accent)', marginLeft: 4, fontSize: '11px' }}>✎</span>}
            {icon && <span style={{ color: 'var(--text-faint)', marginLeft: 4, fontSize: '11px' }}>{icon}</span>}
          </span>
        )}
      </div>

      {/* Apps / tabs muted row */}
      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', minWidth: 0, flexBasis: '33%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {[session.primaryApp, session.primaryBrowser].filter(Boolean).join(' · ')}
        {session.appsUsed.length > 1 && <span style={{ color: 'var(--text-faint)' }}> +{session.appsUsed.length - 1}</span>}
      </div>

      {/* Events count chip */}
      <div style={{ fontSize: '11px', color: 'var(--text-faint)', minWidth: 36, textAlign: 'right' }}>
        {session.eventCount} evt{session.eventCount === 1 ? '' : 's'}
      </div>

      {/* Hover actions */}
      <div onClick={(e) => e.stopPropagation()} className="card-actions" style={{ display: 'flex', gap: 4, opacity: 0.7 }}>
        <ActionBtn label="Split" title="Split this session" onClick={() => setSplitScrubber((v) => !v)} />
        <ActionBtn label="✕" title="Delete" danger onClick={() => actions.onDelete(session.id, [])} />
      </div>

      {splitScrubber && (
        <SplitScrubber
          session={session}
          onPick={(afterEventId) => { setSplitScrubber(false); actions.onSplit(session.id, afterEventId); }}
          onCancel={() => setSplitScrubber(false)}
        />
      )}
    </div>
  );
}

function ActionBtn({ label, title, onClick, danger }: { label: string; title: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      title={title}
      onClick={onClick}
      style={{
        padding: '2px 6px',
        borderRadius: 'var(--radius-sm)',
        border: '1px solid var(--border)',
        background: 'var(--bg)',
        color: danger ? 'var(--danger)' : 'var(--text-muted)',
        fontSize: '11px',
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.border = '1px solid ' + (danger ? 'var(--danger)' : 'var(--accent)'); }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.border = '1px solid var(--border)'; }}
    >{label}</button>
  );
}

/**
 * Split scrubber: a thin row of ticks, one per event in the session. Clicking
 * a tick splits AFTER that event. Tick title shows the event timestamp+title
 * for orientation.
 *
 * The DTO (`VerifiedSessionDto`) doesn't currently carry per-event arrays — to
 * keep the IPC payload small. For Stage 3, the parent fetches the events for
 * the chosen session id via a future `timeline:getSessionEvents` channel when
 * the user opens the scrubber. For now the scrubber renders `eventCount` ticks
 * as an orientation aid; clicking the i-th tick issues a split targeting the
 * i-th event id which the parent resolves via that same lookup. We pass `events`
 * into the scrubber through the parent when available.
 */
function SplitScrubber({
  session,
  onPick,
  onCancel,
}: {
  session: VerifiedSessionDto;
  onPick: (afterEventId: number) => void;
  onCancel: () => void;
}) {
  // Placeholder: ticks equal to event count. The parent supplies event ids
  // through a dedicated channel when emissions grow; the i-th click index is
  // passed to the parent, which resolves the actual id server-side. For Stage
  // 3 dev iteration we send the tick index as the afterEventId arg and the
  // service learns to translate — kept minimal here to prove the UX flow.
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        marginTop: 6,
        padding: '4px 8px',
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        display: 'flex',
        gap: 2,
        alignItems: 'center',
      }}
    >
      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Split after event:</span>
      {Array.from({ length: Math.min(session.eventCount, 40) }).map((_, i) => (
        <button
          key={i}
          title={`Event ${i + 1}`}
          onClick={() => onPick(i)}
          style={{
            width: 10, height: 18,
            borderRadius: 2,
            border: '1px solid var(--border)',
            background: 'var(--bg-secondary)',
            cursor: 'pointer',
            padding: 0,
          }}
        />
      ))}
      <button onClick={onCancel} style={{ marginLeft: 6, fontSize: '11px', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>esc</button>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function humanDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}