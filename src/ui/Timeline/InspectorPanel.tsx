/**
 * Persistent Inspector Panel for the Day View timeline.
 *
 * Always visible. Two modes:
 *   - No selection → DailySummary (total tracked, session count, longest,
 *     manual edits, timeline integrity).
 *   - One selected  → SessionDetail (title, start/end/duration, apps, tabs,
 *     notes, edit history, actions, + future AI placeholders).
 *
 * Never a modal: it's a right-side dock that updates when selection changes.
 * When the viewed day is not "today", actions are disabled with a read-only
 * note (the backend resolves edit hints against today only).
 */
import { useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { InlineEditor } from './InlineEditor';
import {
  fmtDuration,
  fmtHm,
  appHueIndex,
  totalTracked,
  longestSession,
  manualEditCount,
  totalEventCount,
} from './timelineUtils';

export interface InspectorActions {
  onRename: (id: string, newTitle: string) => void;
  onSplit: (id: string) => void;
  onMerge: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onToggleOffline: (id: string, offline: boolean) => void;
  onNoteChange: (id: string, note: string) => void;
  onCopyDetails: (session: VerifiedSessionDto) => void;
}

interface InspectorPanelProps {
  sessions: VerifiedSessionDto[];
  selectedId: string | null;
  isToday: boolean;
  dayLabel: string;
  actions: InspectorActions;
}

export function InspectorPanel({ sessions, selectedId, isToday, dayLabel, actions }: InspectorPanelProps) {
  const selected = selectedId ? sessions.find((s) => s.id === selectedId) ?? null : null;

  return (
    <aside
      style={{
        width: '100%',
        height: '100%',
        borderLeft: '1px solid var(--border)',
        background: 'var(--bg-secondary)',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
      }}
    >
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Inspector
        </div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-faint)', marginTop: 2 }}>
          {selected ? '1 session selected' : dayLabel}
        </div>
      </div>

      {selected ? (
        <SessionDetail
          session={selected}
          isToday={isToday}
          actions={actions}
        />
      ) : (
        <DailySummary sessions={sessions} />
      )}
    </aside>
  );
}

// ── No selection ──────────────────────────────────────────────────────────────

function DailySummary({ sessions }: { sessions: VerifiedSessionDto[] }) {
  const tracked = totalTracked(sessions);
  const longest = longestSession(sessions);
  const manual = manualEditCount(sessions);
  const events = totalEventCount(sessions);

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SummaryStat label="Total tracked" value={fmtDuration(tracked)} />
      <SummaryStat label="Sessions" value={String(sessions.length)} />
      <SummaryStat
        label="Longest session"
        value={longest ? `${longest.title || '(unlabelled)'}` : '—'}
        sub={longest ? fmtDuration(longest.duration) : undefined}
      />
      <SummaryStat label="Manual / offline" value={String(manual)} />
      <SummaryStat label="Events captured" value={String(events)} />
      <SummaryStat label="Timeline integrity" value={sessions.length === 0 ? '—' : 'verified'} sub={sessions.length === 0 ? undefined : `${events} events → ${sessions.length} sessions`} />

      <div style={{ marginTop: 4, fontSize: '11.5px', color: 'var(--text-faint)' }}>
        Select a session to edit details and notes.
      </div>
    </div>
  );
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: '14px', color: 'var(--text)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
      {sub && <div style={{ fontSize: '11.5px', color: 'var(--text-faint)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ── One selected ─────────────────────────────────────────────────────────────

function SessionDetail({
  session,
  isToday,
  actions,
}: {
  session: VerifiedSessionDto;
  isToday: boolean;
  actions: InspectorActions;
}) {
  const [editing, setEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState(session.note ?? '');
  const hueIdx = appHueIndex(session.primaryApp);
  const isOffline = session.source === 'user';

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Color swatch + title */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', marginTop: 5, background: `var(--block-hue-${hueIdx})`, flexShrink: 0 }} />
        {editing ? (
          <InlineEditor
            initial={session.title}
            onCommit={(v) => { setEditing(false); actions.onRename(session.id, v); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
            style={{ fontSize: '15px', fontWeight: 600, flex: 1, cursor: isToday ? 'text' : 'default', lineHeight: 1.3 }}
          >
            {session.title || <em style={{ color: 'var(--text-faint)' }}>{isOffline ? '(offline)' : '(unlabelled)'}</em>}
            {session.isCustomTitle && <span style={{ marginLeft: 6, color: 'var(--accent)', fontSize: '11px' }}>✎</span>}
          </div>
        )}
      </div>

      {/* Time / duration */}
      <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
        {fmtHm(session.startedAt)} – {fmtHm(session.endedAt)} · {fmtDuration(session.duration)}
        {session.activeDuration > 0 && session.activeDuration < session.duration && (
          <span style={{ color: 'var(--text-faint)' }}> · {fmtDuration(session.activeDuration)} active</span>
        )}
      </div>

      {/* Source toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12.5px', color: 'var(--text-muted)', cursor: isToday ? 'pointer' : 'default' }}>
        <input
          type="checkbox"
          disabled={!isToday}
          checked={isOffline}
          onChange={(e) => actions.onToggleOffline(session.id, e.target.checked)}
        />
        Offline activity
      </label>

      {/* Read-only note */}
      {!isToday && (
        <div style={{ fontSize: '11.5px', color: 'var(--text-faint)', background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)', padding: '6px 8px' }}>
          Read-only — only today is editable.
        </div>
      )}

      {/* Note */}
      {isToday && (
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Note</div>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            onBlur={() => actions.onNoteChange(session.id, noteDraft)}
            placeholder="Add a note…"
            rows={3}
            style={{
              width: '100%',
              resize: 'none',
              padding: 6,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg)',
              color: 'var(--text)',
              fontSize: '12.5px',
            }}
          />
        </div>
      )}

      {/* Apps */}
      <div>
        <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Apps</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {session.appsUsed.length === 0 && <span style={{ fontSize: '12px', color: 'var(--text-faint)' }}>—</span>}
          {session.appsUsed.map((a) => (
            <span key={a} className="chip">{a}</span>
          ))}
        </div>
      </div>

      {/* Tabs */}
      {session.browserTabs.length > 0 && (
        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 4 }}>Tabs</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {session.browserTabs.map((t) => (
              <span key={t} className="chip" style={{ fontSize: '11px', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</span>
            ))}
          </div>
        </div>
      )}

      {/* Edit history */}
      <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
        {session.isCustomTitle ? 'Renamed' : 'Auto-titled'} · {session.source === 'user' ? 'Offline entry' : 'Generated'} · {session.eventCount} event{session.eventCount === 1 ? '' : 's'}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <InspBtn disabled={!isToday} onClick={() => setEditing(true)}>Rename</InspBtn>
        <InspBtn disabled={!isToday} onClick={() => actions.onSplit(session.id)}>Split</InspBtn>
        <InspBtn disabled={!isToday} onClick={() => actions.onMerge(session.id)}>Merge</InspBtn>
        <InspBtn disabled={!isToday} onClick={() => actions.onDuplicate(session.id)}>Duplicate</InspBtn>
        <InspBtn disabled={!isToday} onClick={() => actions.onDelete(session.id)} danger>Delete</InspBtn>
        <InspBtn disabled={!isToday} onClick={() => actions.onToggleOffline(session.id, !isOffline)}>{isOffline ? 'Mark generated' : 'Mark offline'}</InspBtn>
        <InspBtn onClick={() => actions.onCopyDetails(session)}>Copy details</InspBtn>
      </div>

      {/* Future placeholders */}
      <div style={{ marginTop: 6, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
        <div style={{ fontSize: '11px', color: 'var(--text-faint)', marginBottom: 6 }}>Coming soon</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Placeholder>AI Classification</Placeholder>
          <Placeholder>AI Explanation</Placeholder>
          <Placeholder>Project</Placeholder>
          <Placeholder>Tags</Placeholder>
        </div>
      </div>
    </div>
  );
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 'var(--radius-sm)',
        border: '1px dashed var(--border-strong)',
        color: 'var(--text-faint)',
        fontSize: '11px',
      }}
    >
      {children}
    </span>
  );
}

function InspBtn({ children, onClick, disabled, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '3px 8px',
        borderRadius: 'var(--radius-sm)',
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        background: danger ? 'var(--danger-soft)' : 'var(--bg)',
        color: disabled ? 'var(--text-faint)' : danger ? 'var(--danger)' : 'var(--text-muted)',
        fontSize: '11.5px',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}