import { useEffect, useMemo, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { InlineEditor } from './InlineEditor';
import {
  categoryHueIndex,
  fmtDuration,
  fmtHm,
  sessionCategory,
  totalEventCount,
  totalTracked,
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
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '14px 18px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase' }}>
            Inspector
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-faint)' }}>
            {selected ? 'selected' : dayLabel}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {selected ? (
          <SessionDetail session={selected} sessions={sessions} isToday={isToday} actions={actions} />
        ) : (
          <EmptyInspector sessions={sessions} />
        )}
      </div>
    </aside>
  );
}

function EmptyInspector({ sessions }: { sessions: VerifiedSessionDto[] }) {
  const tracked = totalTracked(sessions);
  const events = totalEventCount(sessions);
  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 18, animation: 'inspectorIn 140ms var(--ease-out)' }}>
      <section>
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 8 }}>
          No Session Selected
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Click any session to inspect or edit it. Double-click empty timeline space to create an offline activity.
        </div>
      </section>

      <Section title="Instructions">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '12.5px', color: 'var(--text-muted)' }}>
          <div>Single click opens session details here.</div>
          <div>Double click a session title to rename it.</div>
          <div>Use the action buttons here for split, merge, or delete.</div>
        </div>
      </Section>

      <Section title="Day Summary">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Metric label="Sessions" value={String(sessions.length)} />
          <Metric label="Tracked" value={fmtDuration(tracked)} />
          <Metric label="Events" value={String(events)} />
          <Metric label="Average" value={sessions.length ? fmtDuration(tracked / sessions.length) : '0s'} />
        </div>
      </Section>
    </div>
  );
}

function SessionDetail({
  session,
  sessions,
  isToday,
  actions,
}: {
  session: VerifiedSessionDto;
  sessions: VerifiedSessionDto[];
  isToday: boolean;
  actions: InspectorActions;
}) {
  const [editing, setEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState(session.note ?? '');
  const [eventsOpen, setEventsOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const category = sessionCategory(session);
  const hueIdx = categoryHueIndex(category);
  const isOffline = session.source === 'user';

  useEffect(() => {
    setEditing(false);
    setNoteDraft(session.note ?? '');
    setEventsOpen(true);
  }, [session.id, session.note]);

  const adjacent = useMemo(() => {
    const sorted = [...sessions].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
    const idx = sorted.findIndex((s) => s.id === session.id);
    return {
      prev: idx > 0 ? sorted[idx - 1] : null,
      next: idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null,
    };
  }, [sessions, session.id]);

  return (
    <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16, animation: 'inspectorIn 140ms var(--ease-out)' }}>
      <section>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
          <div style={{ width: 12, height: 12, borderRadius: 4, marginTop: 6, background: `var(--block-hue-${hueIdx})`, flexShrink: 0 }} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {editing ? (
              <InlineEditor
                initial={session.title}
                placeholder="Session title"
                onCommit={(v) => { setEditing(false); actions.onRename(session.id, v); }}
                onCancel={() => setEditing(false)}
              />
            ) : (
              <button
                onDoubleClick={() => { if (isToday) setEditing(true); }}
                title={isToday ? 'Double-click to rename' : undefined}
                style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 19, fontWeight: 700, lineHeight: 1.18, color: 'var(--text)', cursor: isToday ? 'text' : 'default' }}
              >
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {session.title || (isOffline ? 'Offline activity' : 'Untitled session')}
                </span>
              </button>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <span className="chip" style={{ borderColor: `var(--block-hue-${hueIdx})` }}>{labelForCategory(category)}</span>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: '12.5px', color: 'var(--text-muted)', cursor: isToday ? 'pointer' : 'default' }}>
                <input
                  type="checkbox"
                  disabled={!isToday}
                  checked={isOffline}
                  onChange={(e) => actions.onToggleOffline(session.id, e.target.checked)}
                />
                Offline
              </label>
            </div>
          </div>
        </div>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Metric label="Start" value={fmtHm(session.startedAt)} />
        <Metric label="End" value={fmtHm(session.endedAt)} />
        <Metric label="Duration" value={fmtDuration(session.duration)} />
        <Metric label="Events" value={String(session.eventCount)} />
      </div>

      {!isToday && (
        <div style={{ fontSize: '12px', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', background: 'var(--bg)' }}>
          This day is read-only. Editing is available for today's timeline.
        </div>
      )}

      <Section title="Actions">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          <InspBtn disabled={!isToday} onClick={() => setEditing(true)}>Rename</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onSplit(session.id)}>Split</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onMerge(session.id)}>Merge</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onDelete(session.id)} danger>Delete</InspBtn>
        </div>
      </Section>

      <Section title="Notes">
        <textarea
          value={noteDraft}
          disabled={!isToday}
          onChange={(e) => setNoteDraft(e.target.value)}
          onBlur={() => { if (isToday) actions.onNoteChange(session.id, noteDraft); }}
          placeholder="Add a note"
          rows={4}
          style={{
            width: '100%',
            resize: 'vertical',
            minHeight: 92,
            padding: 10,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: '13px',
            lineHeight: 1.45,
            outline: 'none',
          }}
        />
      </Section>

      <Section title="Event List">
        <DisclosureButton open={eventsOpen} onClick={() => setEventsOpen((v) => !v)}>
          {session.eventCount} event{session.eventCount === 1 ? '' : 's'}
        </DisclosureButton>
        {eventsOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 9 }}>
            {session.eventIds.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-faint)' }}>No raw events attached.</div>
            ) : session.eventIds.map((id, index) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, padding: '3px 0', fontSize: '12.5px', color: 'var(--text-muted)' }}>
                <span style={{ width: 20, color: 'var(--text-faint)', textAlign: 'right' }}>{index + 1}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.primaryApp || 'Activity'}{session.primaryTitle ? ` · ${session.primaryTitle}` : ''}
                </span>
                <span style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>#{id}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Apps Used">
        <PillList values={session.appsUsed} empty="No app data" />
      </Section>

      <Section title="Websites">
        <PillList values={session.browserTabs} empty={session.primaryUrl ? session.primaryUrl : 'No website data'} />
      </Section>

      <Section title="History">
        <DisclosureButton open={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
          {session.isCustomTitle || session.note || isOffline ? 'Manual changes present' : 'Generated session'}
        </DisclosureButton>
        {historyOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8, fontSize: '12px', color: 'var(--text-muted)' }}>
            <HistoryLine label="Title" value={session.isCustomTitle ? 'Renamed' : 'Auto titled'} />
            <HistoryLine label="Source" value={isOffline ? 'Offline' : 'Generated'} />
            <HistoryLine label="Previous" value={adjacent.prev ? adjacent.prev.title || fmtHm(adjacent.prev.startedAt) : 'None'} />
            <HistoryLine label="Next" value={adjacent.next ? adjacent.next.title || fmtHm(adjacent.next.startedAt) : 'None'} />
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid var(--border)', paddingTop: 13 }}>
      <div style={{ fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 9 }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 11px', minWidth: 0 }}>
      <div style={{ fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '15px', color: 'var(--text)', fontWeight: 700, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function PillList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <div style={{ fontSize: '12.5px', color: 'var(--text-faint)' }}>{empty}</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {values.map((value) => (
        <span key={value} className="chip" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value}
        </span>
      ))}
    </div>
  );
}

function DisclosureButton({ open, onClick, children }: { open: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: '12.5px', color: 'var(--text)', textAlign: 'left' }}
    >
      <span style={{ color: 'var(--text-faint)', width: 10 }}>{open ? 'v' : '>'}</span>
      <span>{children}</span>
    </button>
  );
}

function HistoryLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ width: 70, color: 'var(--text-faint)' }}>{label}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

function InspBtn({ children, onClick, disabled, danger }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 32,
        padding: '0 10px',
        borderRadius: 8,
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        background: danger ? 'var(--danger-soft)' : 'var(--bg)',
        color: disabled ? 'var(--text-faint)' : danger ? 'var(--danger)' : 'var(--text)',
        fontSize: '12.5px',
        fontWeight: 650,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 130ms var(--ease-out), border-color 130ms var(--ease-out), transform 130ms var(--ease-out)',
      }}
    >
      {children}
    </button>
  );
}

function labelForCategory(category: ReturnType<typeof sessionCategory>): string {
  switch (category) {
    case 'development': return 'Development';
    case 'learning': return 'Learning';
    case 'meetings': return 'Meetings';
    case 'entertainment': return 'Entertainment';
    case 'offline': return 'Offline';
  }
}
