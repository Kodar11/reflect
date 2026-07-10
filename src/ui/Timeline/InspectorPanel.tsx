import { useEffect, useMemo, useState } from 'react';
import type { VerifiedSessionDto } from '../../timeline/timelineIpc';
import { InlineEditor } from './InlineEditor';
import {
  categoryHueIndex,
  fmtDuration,
  fmtHm,
  sessionCategory,
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
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 650, textTransform: 'uppercase' }}>
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
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <div style={{ fontSize: 22, fontWeight: 650, lineHeight: 1.1 }}>{fmtDuration(tracked)}</div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: 4 }}>
          {sessions.length} session{sessions.length === 1 ? '' : 's'} tracked
        </div>
      </div>
      <div style={{ fontSize: '12.5px', color: 'var(--text-faint)', lineHeight: 1.5 }}>
        Select a block to rename, annotate, inspect events, or edit the session.
      </div>
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
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: 3, marginTop: 6, background: `var(--block-hue-${hueIdx})`, flexShrink: 0 }} />
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
                style={{ display: 'block', width: '100%', textAlign: 'left', fontSize: 18, fontWeight: 650, lineHeight: 1.2, color: 'var(--text)', cursor: isToday ? 'text' : 'default' }}
              >
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {session.title || (isOffline ? 'Offline activity' : 'Untitled session')}
                </span>
              </button>
            )}
            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginTop: 6 }}>
              {fmtHm(session.startedAt)}-{fmtHm(session.endedAt)} · {fmtDuration(session.duration)}
            </div>
          </div>
        </div>
      </section>

      {!isToday && (
        <div style={{ fontSize: '12px', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', background: 'var(--bg)' }}>
          This day is read-only. Editing is available for today's timeline.
        </div>
      )}

      <Section title="Category">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
            minHeight: 78,
            padding: 9,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: '12.5px',
            lineHeight: 1.45,
            outline: 'none',
          }}
        />
      </Section>

      <Section title="Apps Used">
        <PillList values={session.appsUsed} empty="No app data" />
      </Section>

      <Section title="Websites">
        <PillList values={session.browserTabs} empty={session.primaryUrl ? session.primaryUrl : 'No website data'} />
      </Section>

      <Section title="Raw Events">
        <DisclosureButton open={eventsOpen} onClick={() => setEventsOpen((v) => !v)}>
          {session.eventCount} event{session.eventCount === 1 ? '' : 's'}
        </DisclosureButton>
        {eventsOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {session.eventIds.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-faint)' }}>No raw events attached.</div>
            ) : session.eventIds.map((id, index) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, fontSize: '12px', color: 'var(--text-muted)' }}>
                <span style={{ width: 18, color: 'var(--text-faint)', textAlign: 'right' }}>{index + 1}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {session.primaryApp || 'Activity'}{session.primaryTitle ? ` · ${session.primaryTitle}` : ''}
                </span>
                <span style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums' }}>#{id}</span>
              </div>
            ))}
          </div>
        )}
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

      <Section title="Actions">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
          <InspBtn disabled={!isToday} onClick={() => setEditing(true)}>Rename</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onSplit(session.id)}>Split</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onMerge(session.id)}>Merge</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onDuplicate(session.id)}>Duplicate</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onToggleOffline(session.id, !isOffline)}>Convert Offline</InspBtn>
          <InspBtn onClick={() => actions.onCopyDetails(session)}>Copy Details</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onDelete(session.id)} danger>Delete</InspBtn>
        </div>
      </Section>

      <Section title="Future AI">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Placeholder>Explain</Placeholder>
          <Placeholder>Classify</Placeholder>
          <Placeholder>Project</Placeholder>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 650, marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </section>
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

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 6, border: '1px dashed var(--border-strong)', color: 'var(--text-faint)', fontSize: '11.5px' }}>
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
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 30,
        padding: '0 10px',
        borderRadius: 6,
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        background: danger ? 'var(--danger-soft)' : 'var(--bg)',
        color: disabled ? 'var(--text-faint)' : danger ? 'var(--danger)' : 'var(--text)',
        fontSize: '12px',
        fontWeight: 500,
        cursor: disabled ? 'not-allowed' : 'pointer',
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
