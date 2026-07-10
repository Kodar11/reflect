import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  Clock,
  Activity,
  Info,
  Calendar,
  Layers,
  TrendingUp,
  Split,
  Combine,
  Trash2,
  Edit3,
  ExternalLink,
} from 'lucide-react';
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
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Inspector
          </div>
          <div style={{ fontSize: '11.5px', color: 'var(--text-faint)', fontWeight: 500 }}>
            {selected ? 'Selection active' : dayLabel}
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
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 24, animation: 'inspectorIn 140ms var(--ease-out)' }}>
      {/* Centered instruction state */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', padding: '16px 0', borderBottom: '1px solid var(--border)' }}>
        <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--accent-soft)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
          <Sparkles size={20} />
        </div>
        <div style={{ fontSize: '15px', color: 'var(--text)', fontWeight: 700, marginBottom: 4 }}>No session selected</div>
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', maxWidth: 220, lineHeight: 1.45 }}>
          Click any session to inspect or edit it. Double-click empty space to create an offline activity.
        </div>
      </div>

      {/* Instructions card */}
      <section style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12px', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 12 }}>
          <Info size={14} style={{ color: 'var(--accent)' }} />
          <span>Quick Tips</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: '12.5px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>•</span>
            <span>Single click opens details and editing.</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>•</span>
            <span>Double click empty canvas space to log an offline activity.</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>•</span>
            <span>Drag blocks or resize their edges directly on the timeline.</span>
          </div>
        </div>
      </section>

      {/* Day summary cards */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 12 }}>
          <TrendingUp size={13} />
          <span>Day Summary</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <MetricCard icon={<Layers size={14} />} label="Sessions" value={String(sessions.length)} />
          <MetricCard icon={<Clock size={14} />} label="Tracked Time" value={fmtDuration(tracked)} />
          <MetricCard icon={<Activity size={14} />} label="Events" value={String(events)} />
          <MetricCard icon={<Calendar size={14} />} label="Average" value={sessions.length ? fmtDuration(tracked / sessions.length) : '0s'} />
        </div>
      </section>
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
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20, animation: 'inspectorIn 140ms var(--ease-out)' }}>
      {/* Title & Category Header Card */}
      <section style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12, boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span className="chip" style={{ borderColor: `var(--block-hue-${hueIdx})`, background: `rgba(${hueIdx === 0 ? '35, 130, 226' : hueIdx === 1 ? '15, 123, 108' : hueIdx === 2 ? '123, 79, 227' : hueIdx === 3 ? '217, 115, 13' : '115, 115, 115'}, 0.08)`, color: `var(--block-hue-${hueIdx})`, fontWeight: 600 }}>
            {labelForCategory(category)}
          </span>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '12px', color: 'var(--text-muted)', fontWeight: 500, cursor: isToday ? 'pointer' : 'default' }}>
            <input
              type="checkbox"
              disabled={!isToday}
              checked={isOffline}
              onChange={(e) => actions.onToggleOffline(session.id, e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            Offline activity
          </label>
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          {editing ? (
            <InlineEditor
              initial={session.title}
              placeholder="Session title"
              onCommit={(v) => { setEditing(false); actions.onRename(session.id, v); }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
              <button
                onDoubleClick={() => { if (isToday) setEditing(true); }}
                title={isToday ? 'Double-click to rename' : undefined}
                style={{ flex: 1, textAlign: 'left', fontSize: 18, fontWeight: 750, letterSpacing: '-0.02em', lineHeight: 1.25, color: 'var(--text)', cursor: isToday ? 'pointer' : 'default' }}
              >
                {session.title || (isOffline ? 'Offline activity' : 'Untitled session')}
              </button>
              {isToday && (
                <button 
                  onClick={() => setEditing(true)}
                  style={{ color: 'var(--text-faint)', padding: 4 }}
                  title="Rename session"
                >
                  <Edit3 size={15} />
                </button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Time Metrics Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <MetricCard icon={<Clock size={14} style={{ color: 'var(--text-muted)' }} />} label="Start Time" value={fmtHm(session.startedAt)} />
        <MetricCard icon={<Clock size={14} style={{ color: 'var(--text-muted)' }} />} label="End Time" value={fmtHm(session.endedAt)} />
        <MetricCard icon={<Sparkles size={14} style={{ color: 'var(--text-muted)' }} />} label="Duration" value={fmtDuration(session.duration)} />
        <MetricCard icon={<Activity size={14} style={{ color: 'var(--text-muted)' }} />} label="Events" value={String(session.eventCount)} />
      </div>

      {!isToday && (
        <div style={{ fontSize: '12px', color: 'var(--text-faint)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', background: 'var(--bg)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Info size={14} />
          <span>This day is read-only. Editing is available for today's timeline.</span>
        </div>
      )}

      {/* Action Button Group */}
      <Section title="Actions" icon={<Layers size={13} />}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
          <InspBtn disabled={!isToday} onClick={() => setEditing(true)} icon={<Edit3 size={13} />}>Rename</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onSplit(session.id)} icon={<Split size={13} />}>Split</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onMerge(session.id)} icon={<Combine size={13} />}>Merge</InspBtn>
          <InspBtn disabled={!isToday} onClick={() => actions.onDelete(session.id)} danger icon={<Trash2 size={13} />}>Delete</InspBtn>
        </div>
      </Section>

      {/* Notes Textarea */}
      <Section title="Notes" icon={<Edit3 size={13} />}>
        <textarea
          value={noteDraft}
          disabled={!isToday}
          onChange={(e) => setNoteDraft(e.target.value)}
          placeholder="Add some notes about what you did..."
          rows={3}
          style={{
            width: '100%',
            resize: 'vertical',
            minHeight: 80,
            padding: '10px 12px',
            borderRadius: 10,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            color: 'var(--text)',
            fontSize: '13px',
            lineHeight: 1.5,
            outline: 'none',
            transition: 'border-color var(--dur-fast) ease',
          }}
          onFocus={(e) => e.target.style.borderColor = 'var(--accent)'}
          onBlur={(e) => {
            e.target.style.borderColor = 'var(--border)';
            if (isToday) actions.onNoteChange(session.id, noteDraft);
          }}
        />
      </Section>

      {/* Event List */}
      <Section title="Event List" icon={<Activity size={13} />}>
        <DisclosureButton open={eventsOpen} onClick={() => setEventsOpen((v) => !v)}>
          {session.eventCount} raw event{session.eventCount === 1 ? '' : 's'}
        </DisclosureButton>
        {eventsOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, maxHeight: 180, overflowY: 'auto', paddingRight: 4 }}>
            {session.eventIds.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-faint)', padding: '4px 0' }}>No raw events attached.</div>
            ) : session.eventIds.map((id, index) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, padding: '3px 6px', fontSize: '12px', color: 'var(--text-muted)', background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)' }}>
                <span style={{ width: 16, color: 'var(--text-faint)', fontWeight: 600, fontSize: '10px', textAlign: 'right' }}>{index + 1}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 }}>
                  {session.primaryApp || 'Activity'}{session.primaryTitle ? ` · ${session.primaryTitle}` : ''}
                </span>
                <span style={{ color: 'var(--text-faint)', fontVariantNumeric: 'tabular-nums', fontSize: '10px' }}>#{id}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Apps & Websites */}
      <Section title="Apps Used" icon={<Layers size={13} />}>
        <PillList values={session.appsUsed} empty="No app data" />
      </Section>

      <Section title="Websites" icon={<ExternalLink size={13} />}>
        <PillList values={session.browserTabs} empty={session.primaryUrl ? session.primaryUrl : 'No website data'} />
      </Section>

      {/* History */}
      <Section title="History" icon={<Clock size={13} />}>
        <DisclosureButton open={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>
          {session.isCustomTitle || session.note || isOffline ? 'Manual changes present' : 'Generated session'}
        </DisclosureButton>
        {historyOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10, fontSize: '12px', color: 'var(--text-muted)', background: 'var(--bg)', padding: 12, borderRadius: 10, border: '1px solid var(--border)' }}>
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

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700, marginBottom: 10 }}>
        {icon}
        <span>{title}</span>
      </div>
      {children}
    </section>
  );
}

function MetricCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 12, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 4, boxShadow: 'var(--shadow-sm)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)' }}>
        {icon}
        <span style={{ fontSize: '11px', color: 'var(--text-faint)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.02em' }}>{label}</span>
      </div>
      <div style={{ fontSize: '16px', color: 'var(--text)', fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</div>
    </div>
  );
}

function PillList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <div style={{ fontSize: '12.5px', color: 'var(--text-faint)', padding: '2px 0' }}>{empty}</div>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {values.map((value) => (
        <span key={value} className="chip" style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: 8 }}>
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
      style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', fontSize: '12.5px', color: 'var(--text)', textAlign: 'left', fontWeight: 600 }}
    >
      <span style={{ color: 'var(--text-faint)', width: 10 }}>{open ? '▼' : '►'}</span>
      <span>{children}</span>
    </button>
  );
}

function HistoryLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ width: 70, color: 'var(--text-faint)', fontWeight: 500 }}>{label}</span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function InspBtn({ children, onClick, disabled, danger, icon }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; icon?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        minHeight: 34,
        padding: '0 12px',
        borderRadius: 8,
        border: `1px solid ${danger ? 'var(--danger)' : 'var(--border)'}`,
        background: danger ? 'var(--danger-soft)' : 'var(--bg)',
        color: disabled ? 'var(--text-faint)' : danger ? 'var(--danger)' : 'var(--text)',
        fontSize: '12.5px',
        fontWeight: 650,
        cursor: disabled ? 'not-allowed' : 'pointer',
        transition: 'background 130ms var(--ease-out), border-color 130ms var(--ease-out), transform 130ms var(--ease-out)',
      }}
      onMouseEnter={(e) => { if (!disabled) { (e.currentTarget as HTMLElement).style.background = danger ? 'rgba(224, 62, 62, 0.18)' : 'var(--bg-hover)'; } }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = danger ? 'var(--danger-soft)' : 'var(--bg)'; }}
    >
      {icon}
      <span>{children}</span>
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
