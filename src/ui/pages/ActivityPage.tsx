import { useEffect, useState, useCallback, useMemo } from 'react';
import { Search, Activity, Clock, ArrowUpDown, Layers, Globe, Monitor, HelpCircle } from 'lucide-react';

interface TrackerEventDto {
  id: number;
  watcher: string;
  app: string | null;
  title: string | null;
  url: string | null;
  startedAt: string;
  endedAt: string;
}

interface UsageRow {
  key: string;
  name: string;
  type: 'App' | 'Website';
  totalTime: number;
  sessionCount: number;
  lastUsed: Date;
  latestActivity: string;
  intervals: { startedAt: Date; endedAt: Date }[];
}

const CURATED_COLORS = [
  { name: 'blue', hex: '#3b82f6' },
  { name: 'green', hex: '#10b981' },
  { name: 'purple', hex: '#8b5cf6' },
  { name: 'orange', hex: '#f97316' },
  { name: 'yellow', hex: '#eab308' },
  { name: 'red', hex: '#ef4444' },
  { name: 'cyan', hex: '#06b6d4' },
  { name: 'gray', hex: '#6b7280' },
  { name: 'pink', hex: '#ec4899' },
  { name: 'brown', hex: '#a16207' },
];

export function ActivityPage({
  activeTab = 'events',
  onTabChange,
  editingRuleId,
  setEditingRuleId,
  prefilledRule,
  setPrefilledRule,
}: {
  activeTab?: 'events' | 'usage' | 'rules';
  onTabChange?: (tab: 'events' | 'usage' | 'rules') => void;
  editingRuleId?: string | null;
  setEditingRuleId?: (id: string | null) => void;
  prefilledRule?: any | null;
  setPrefilledRule?: (rule: any | null) => void;
}) {
  const [events, setEvents] = useState<TrackerEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [usageSearchQuery, setUsageSearchQuery] = useState('');
  const [rulesSearchQuery, setRulesSearchQuery] = useState('');

  // Selected row state for Usage Details panel
  const [selectedUsageKey, setSelectedUsageKey] = useState<string | null>(null);

  // Usage tab sorting
  const [sortField, setSortField] = useState<'name' | 'type' | 'totalTime' | 'sessionCount' | 'lastUsed'>('totalTime');
  const [sortAsc, setSortAsc] = useState(false);

  // Rules metadata state
  const [activities, setActivities] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [rulesSortAsc, setRulesSortAsc] = useState(true);

  // Rule Editor State
  const [editorOpen, setEditorOpen] = useState(false);
  const [editRule, setEditRule] = useState<{
    id: string;
    activityId: string;
    name: string;
    color: string;
    conditions: { type: string; value: string }[];
    enabled: boolean;
  } | null>(null);

  const refreshActivitiesAndRules = async () => {
    try {
      const [actList, ruleList] = await Promise.all([
        window.timeline.listActivities(),
        window.timeline.listRules(),
      ]);
      setActivities(actList);
      setRules(ruleList);
    } catch (e) {
      console.error('Failed to load rules', e);
    }
  };

  useEffect(() => {
    refreshActivitiesAndRules();
  }, []);

  // Sync tab navigation state with localStorage
  useEffect(() => {
    localStorage.setItem('reflect_activity_tab', activeTab);
  }, [activeTab]);

  // Load rules when activeTab switches to rules
  useEffect(() => {
    if (activeTab === 'rules') {
      refreshActivitiesAndRules();
    }
  }, [activeTab]);

  // Edit deep-link trigger
  useEffect(() => {
    if (editingRuleId && rules.length > 0 && activities.length > 0) {
      const rule = rules.find((r) => r.id === editingRuleId);
      if (rule) {
        const act = activities.find((a) => a.id === rule.activityId);
        let conds = [];
        try {
          conds = JSON.parse(rule.conditions);
        } catch {}
        setEditRule({
          id: rule.id,
          activityId: rule.activityId,
          name: act?.name ?? '',
          color: act?.color ?? 'blue',
          conditions: conds,
          enabled: rule.enabled === 1,
        });
        setEditorOpen(true);
      }
    }
  }, [editingRuleId, rules, activities]);

  // Prefill new rule from selected session trigger
  useEffect(() => {
    if (prefilledRule) {
      const getDomain = (rawUrl: string) => {
        try {
          let host = rawUrl;
          if (!/^https?:\/\//i.test(host)) host = 'https://' + host;
          const u = new URL(host);
          return u.hostname.startsWith('www.') ? u.hostname.slice(4) : u.hostname;
        } catch {
          const match = rawUrl.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
          return (match && match[1]) ? match[1] : rawUrl;
        }
      };

      const isWeb = !!prefilledRule.primaryUrl || (prefilledRule.browserTabs && prefilledRule.browserTabs.length > 0);
      const appVal = prefilledRule.primaryApp ?? 'App';
      const condVal = isWeb ? getDomain(prefilledRule.primaryUrl ?? prefilledRule.browserTabs[0] ?? '') : appVal;

      const prefilledCond = {
        type: isWeb ? 'domain_equals' : 'app_equals',
        value: condVal || 'VS Code',
      };

      const tempActId = `act_${Date.now()}`;
      const tempRuleId = `rule_${Date.now()}`;

      setEditRule({
        id: tempRuleId,
        activityId: tempActId,
        name: prefilledRule.activity?.name ?? appVal,
        color: prefilledRule.activity?.color ?? 'blue',
        conditions: [prefilledCond],
        enabled: true,
      });
      setEditorOpen(true);
    }
  }, [prefilledRule]);

  // Load tracker events
  const loadEvents = useCallback(async () => {
    try {
      const rows = await window.tracker.getToday();
      setEvents(rows);
      setError(null);
    } catch (e) {
      setError((e as Error)?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadEvents();
    const t = setInterval(loadEvents, 3000);
    return () => clearInterval(t);
  }, [loadEvents]);

  // Filters
  const filteredEvents = useMemo(() => {
    if (!searchQuery.trim()) return events;
    const q = searchQuery.toLowerCase();
    return events.filter(
      (e) =>
        (e.app && e.app.toLowerCase().includes(q)) ||
        (e.title && e.title.toLowerCase().includes(q)) ||
        (e.url && e.url.toLowerCase().includes(q)) ||
        (e.watcher && e.watcher.toLowerCase().includes(q))
    );
  }, [events, searchQuery]);

  const usageData = useMemo(() => {
    const map = new Map<string, UsageRow>();
    for (const e of events) {
      const started = new Date(e.startedAt);
      const ended = new Date(e.endedAt);
      const duration = Math.max(0, ended.getTime() - started.getTime());
      const { name, type } = getEventNameAndType(e);

      const key = `${name}|${type}`;
      let row = map.get(key);
      if (!row) {
        row = {
          key,
          name,
          type,
          totalTime: 0,
          sessionCount: 0,
          lastUsed: started,
          latestActivity: e.title || '',
          intervals: [],
        };
        map.set(key, row);
      }

      row.totalTime += duration;
      row.sessionCount += 1;
      if (started.getTime() > row.lastUsed.getTime()) {
        row.lastUsed = started;
        row.latestActivity = e.title || '';
      }
      row.intervals.push({ startedAt: started, endedAt: ended });
    }

    for (const row of map.values()) {
      row.intervals.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    }
    return Array.from(map.values());
  }, [events]);

  const filteredUsage = useMemo(() => {
    let list = usageData;
    if (usageSearchQuery.trim()) {
      const q = usageSearchQuery.toLowerCase();
      list = list.filter((u) => u.name.toLowerCase().includes(q) || u.type.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      if (sortField === 'name' || sortField === 'type') {
        valA = (valA as string).toLowerCase();
        valB = (valB as string).toLowerCase();
      } else if (sortField === 'lastUsed') {
        valA = (valA as Date).getTime();
        valB = (valB as Date).getTime();
      }

      if (valA < valB) return sortAsc ? -1 : 1;
      if (valA > valB) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [usageData, usageSearchQuery, sortField, sortAsc]);

  const selectedUsage = useMemo(() => {
    if (!selectedUsageKey) return null;
    return usageData.find((u) => u.key === selectedUsageKey) || null;
  }, [usageData, selectedUsageKey]);

  // Rules search and sort
  const filteredRules = useMemo(() => {
    let list = [...rules];
    if (rulesSearchQuery.trim()) {
      const q = rulesSearchQuery.toLowerCase();
      list = list.filter((r) => {
        const act = activities.find((a) => a.id === r.activityId);
        return (
          (act?.name ?? '').toLowerCase().includes(q) ||
          r.conditions.toLowerCase().includes(q)
        );
      });
    }

    list.sort((a, b) => {
      const actA = activities.find((act) => act.id === a.activityId)?.name ?? '';
      const actB = activities.find((act) => act.id === b.activityId)?.name ?? '';
      return rulesSortAsc ? actA.localeCompare(actB) : actB.localeCompare(actA);
    });

    return list;
  }, [rules, activities, rulesSearchQuery, rulesSortAsc]);

  // Actions
  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
  };

  const handleToggleRule = async (rule: any) => {
    try {
      await window.timeline.saveRule({
        ...rule,
        enabled: rule.enabled === 1 ? 0 : 1,
      });
      await refreshActivitiesAndRules();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDuplicateRule = async (rule: any) => {
    try {
      const act = activities.find((a) => a.id === rule.activityId);
      const newActId = `act_${Date.now()}`;
      const newRuleId = `rule_${Date.now()}`;

      await window.timeline.saveActivity({
        id: newActId,
        name: (act?.name ?? 'Cloned') + ' Copy',
        color: act?.color ?? 'blue',
      });

      await window.timeline.saveRule({
        id: newRuleId,
        activityId: newActId,
        conditions: rule.conditions,
        enabled: rule.enabled,
        priority: rule.priority,
      });

      await refreshActivitiesAndRules();
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteRule = async (rule: any) => {
    try {
      await window.timeline.deleteRule({ id: rule.id });
      await window.timeline.deleteActivity({ id: rule.activityId });
      await refreshActivitiesAndRules();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveRule = async () => {
    if (!editRule || !editRule.name.trim()) return;
    try {
      await window.timeline.saveActivity({
        id: editRule.activityId,
        name: editRule.name.trim(),
        color: editRule.color,
      });

      await window.timeline.saveRule({
        id: editRule.id,
        activityId: editRule.activityId,
        conditions: JSON.stringify(editRule.conditions),
        enabled: editRule.enabled ? 1 : 0,
        priority: 0,
      });

      setEditorOpen(false);
      setEditRule(null);
      setEditingRuleId?.(null);
      setPrefilledRule?.(null);
      await refreshActivitiesAndRules();
    } catch (e) {
      console.error(e);
    }
  };

  const handleCancelEditor = () => {
    setEditorOpen(false);
    setEditRule(null);
    setEditingRuleId?.(null);
    setPrefilledRule?.(null);
  };

  return (
    <div className="flex flex-col h-full space-y-5">
      {/* Top Header Card */}
      <section className="card">
        <div className="card-section flex justify-between items-center">
          <div>
            <div className="text-[13px] uppercase tracking-wide text-muted font-semibold">Activity Dashboard</div>
            <h1 className="text-[22px] font-semibold tracking-tight mt-0.5">Timeline Activity</h1>
            <p className="text-[13px] text-muted mt-1">
              Analyze raw events captured today, examine app usage, and configure rule triggers.
            </p>
          </div>
          {/* Tab Button Switcher */}
          <div className="flex bg-secondary p-1 rounded-lg border border-default">
            <button
              onClick={() => onTabChange?.('events')}
              className="px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors"
              style={{
                background: activeTab === 'events' ? 'var(--bg)' : 'transparent',
                color: activeTab === 'events' ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: activeTab === 'events' ? 'var(--shadow-sm)' : 'none',
              }}
            >
              Events
            </button>
            <button
              onClick={() => onTabChange?.('usage')}
              className="px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors"
              style={{
                background: activeTab === 'usage' ? 'var(--bg)' : 'transparent',
                color: activeTab === 'usage' ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: activeTab === 'usage' ? 'var(--shadow-sm)' : 'none',
              }}
            >
              Usage
            </button>
            <button
              onClick={() => onTabChange?.('rules')}
              className="px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors"
              style={{
                background: activeTab === 'rules' ? 'var(--bg)' : 'transparent',
                color: activeTab === 'rules' ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: activeTab === 'rules' ? 'var(--shadow-sm)' : 'none',
              }}
            >
              Rules
            </button>
          </div>
        </div>
      </section>

      {error && (
        <section className="card border-danger">
          <div className="card-section text-[13px] text-danger">
            Failed to load events: {error}
          </div>
        </section>
      )}

      {/* Tab Contents */}
      {activeTab === 'events' ? (
        <div className="card flex-1 min-h-[400px] overflow-hidden flex flex-col">
          <div className="card-section border-b border-default bg-secondary flex justify-between items-center py-3">
            <div className="text-[12.5px] text-muted">Showing {filteredEvents.length} event(s) today.</div>
            <div className="relative w-72">
              <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-muted">
                <Search size={14} />
              </span>
              <input
                type="text"
                placeholder="Search raw events..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="flex-1 overflow-auto relative">
            <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr className="bg-secondary border-b border-default sticky top-0 z-10">
                  {['Time', 'Duration', 'Watcher', 'App', 'Title', 'URL'].map((h) => (
                    <th key={h} className="text-left font-bold px-4 py-2.5 whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredEvents.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-16 text-center text-muted">
                      {loading ? (
                        <span>Loading events...</span>
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-1">
                          <Activity size={32} className="text-faint mb-1 animate-pulse" />
                          <span className="font-semibold text-default">No matching events</span>
                          <span className="text-[12px] text-faint">Try adjusting your search terms or verify tracker settings.</span>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
                {filteredEvents.map((e) => {
                  const started = new Date(e.startedAt);
                  const ended = new Date(e.endedAt);
                  const dur = humanDuration(ended.getTime() - started.getTime());
                  return (
                    <tr key={e.id} className="border-b border-default hover:bg-hover transition-colors">
                      <td className="px-4 py-2 whitespace-nowrap text-muted font-mono">{fmtTime(started)}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-faint font-mono">{dur}</td>
                      <td className="px-4 py-2 whitespace-nowrap font-medium">{e.watcher}</td>
                      <td className="px-4 py-2 font-semibold text-default">{e.app ?? '—'}</td>
                      <td className="px-4 py-2 text-default truncate max-w-xs" title={e.title ?? ''}>{e.title ?? '—'}</td>
                      <td className="px-4 py-2 truncate max-w-xs">
                        {e.url ? (
                          <span className="text-[12px] text-accent font-mono truncate" title={e.url}>{e.url}</span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : activeTab === 'usage' ? (
        <div className="flex gap-5 flex-1 min-h-[400px] h-[calc(100vh-14.5rem)] overflow-hidden">
          <div className="card flex-1 overflow-hidden flex flex-col">
            <div className="card-section border-b border-default bg-secondary flex justify-between items-center py-3">
              <div className="text-[12.5px] text-muted">Showing {filteredUsage.length} application/website entries.</div>
              <div className="relative w-72">
                <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-muted">
                  <Search size={14} />
                </span>
                <input
                  type="text"
                  placeholder="Search apps/sites..."
                  value={usageSearchQuery}
                  onChange={(e) => setUsageSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto relative">
              <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="bg-secondary border-b border-default sticky top-0 z-10 select-none">
                    <th className="text-left font-bold px-4 py-2.5 cursor-pointer hover:text-default" style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('name')}>
                      <div className="flex items-center gap-1">
                        Name <ArrowUpDown size={12} className="opacity-60" />
                      </div>
                    </th>
                    <th className="text-left font-bold px-4 py-2.5 cursor-pointer hover:text-default" style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('type')}>
                      <div className="flex items-center gap-1">
                        Type <ArrowUpDown size={12} className="opacity-60" />
                      </div>
                    </th>
                    <th className="text-left font-bold px-4 py-2.5 cursor-pointer hover:text-default" style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('totalTime')}>
                      <div className="flex items-center gap-1">
                        Total Time <ArrowUpDown size={12} className="opacity-60" />
                      </div>
                    </th>
                    <th className="text-left font-bold px-4 py-2.5 cursor-pointer hover:text-default" style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('sessionCount')}>
                      <div className="flex items-center gap-1">
                        Sessions <ArrowUpDown size={12} className="opacity-60" />
                      </div>
                    </th>
                    <th className="text-left font-bold px-4 py-2.5 cursor-pointer hover:text-default" style={{ color: 'var(--text-muted)' }} onClick={() => handleSort('lastUsed')}>
                      <div className="flex items-center gap-1">
                        Last Used <ArrowUpDown size={12} className="opacity-60" />
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsage.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-16 text-center text-muted">
                        <div className="flex flex-col items-center justify-center gap-1">
                          <Layers size={32} className="text-faint mb-1" />
                          <span className="font-semibold text-default">No usage items found</span>
                          <span className="text-[12px] text-faint">Try typing another search term.</span>
                        </div>
                      </td>
                    </tr>
                  )}
                  {filteredUsage.map((u) => {
                    const isSelected = selectedUsageKey === u.key;
                    return (
                      <tr
                        key={u.key}
                        onClick={() => setSelectedUsageKey(u.key)}
                        className="border-b border-default cursor-pointer transition-colors"
                        style={{ background: isSelected ? 'var(--bg-active)' : 'transparent' }}
                        onMouseEnter={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
                      >
                        <td className="px-4 py-2.5 font-semibold text-default flex items-center gap-2">
                          {u.type === 'Website' ? <Globe size={13} className="text-accent shrink-0" /> : <Monitor size={13} className="text-muted shrink-0" />}
                          <span className="truncate max-w-[200px]" title={u.name}>{u.name}</span>
                        </td>
                        <td className="px-4 py-2.5 text-muted">{u.type}</td>
                        <td className="px-4 py-2.5 font-bold font-mono text-default">{humanDurationShort(u.totalTime)}</td>
                        <td className="px-4 py-2.5 text-default font-mono">{u.sessionCount}</td>
                        <td className="px-4 py-2.5 text-faint font-mono">{fmtTime(u.lastUsed)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="w-[340px] card overflow-hidden flex flex-col shrink-0">
            <div className="card-section border-b border-default bg-secondary py-3 flex items-center gap-2">
              <Activity size={14} className="text-muted" />
              <div className="text-[12px] uppercase tracking-wide text-muted font-bold">Usage Details</div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {selectedUsage ? (
                <div className="space-y-5 animate-fadeIn">
                  <div>
                    <span className="chip font-semibold text-[11px]" style={{ borderColor: selectedUsage.type === 'Website' ? 'var(--accent)' : 'var(--border-strong)', color: selectedUsage.type === 'Website' ? 'var(--accent)' : 'var(--text)' }}>
                      {selectedUsage.type}
                    </span>
                    <h2 className="text-[18px] font-bold mt-2 text-default select-all break-all" title={selectedUsage.name}>
                      {selectedUsage.name}
                    </h2>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-secondary border border-default rounded-xl p-3">
                      <div className="text-[10px] text-muted uppercase font-bold tracking-wide">Total Time</div>
                      <div className="text-[16px] font-extrabold mt-1 text-default font-mono">{humanDurationShort(selectedUsage.totalTime)}</div>
                    </div>
                    <div className="bg-secondary border border-default rounded-xl p-3">
                      <div className="text-[10px] text-muted uppercase font-bold tracking-wide">Events Count</div>
                      <div className="text-[16px] font-extrabold mt-1 text-default font-mono">{selectedUsage.sessionCount}</div>
                    </div>
                  </div>

                  <div className="bg-secondary border border-default rounded-xl p-3 space-y-1">
                    <div className="text-[10px] text-muted uppercase font-bold tracking-wide">Latest Activity</div>
                    <div className="text-[12.5px] font-semibold text-default break-words leading-snug" title={selectedUsage.latestActivity}>{selectedUsage.latestActivity || '—'}</div>
                    <div className="text-[10px] text-faint font-mono pt-1 font-semibold">Last active at {fmtTime(selectedUsage.lastUsed)}</div>
                  </div>

                  <div>
                    <div className="text-[11px] text-muted uppercase font-bold tracking-wide mb-2 flex items-center gap-1.5">
                      <Clock size={12} />
                      <span>Intervals ({selectedUsage.intervals.length})</span>
                    </div>
                    <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                      {selectedUsage.intervals.map((interval, idx) => {
                        const intervalDur = interval.endedAt.getTime() - interval.startedAt.getTime();
                        return (
                          <div key={idx} className="flex justify-between items-center text-[12px] bg-secondary px-3 py-2 rounded-lg border border-default">
                            <span className="font-mono text-muted">{fmtHm(interval.startedAt)} – {fmtHm(interval.endedAt)}</span>
                            <span className="font-bold text-default font-mono">{humanDuration(intervalDur)}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-center text-muted px-4 py-8">
                  <HelpCircle size={36} className="text-faint mb-2" />
                  <div className="text-[13.5px] font-semibold text-default">Select Entry</div>
                  <p className="text-[12.5px] text-muted mt-1 leading-relaxed">
                    Click any application or website row in the table to inspect details and see specific tracking intervals.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* Rules Tab */
        <div className="card flex-1 min-h-[400px] overflow-hidden flex flex-col">
          <div className="card-section border-b border-default bg-secondary flex justify-between items-center py-3">
            <div className="text-[12.5px] text-muted">Showing {filteredRules.length} rule(s) configured.</div>
            <div className="flex gap-3 items-center">
              <div className="relative w-72">
                <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-muted">
                  <Search size={14} />
                </span>
                <input
                  type="text"
                  placeholder="Search Activities..."
                  value={rulesSearchQuery}
                  onChange={(e) => setRulesSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-3 py-1 bg-default border border-default rounded-md text-[13px] text-default placeholder-muted focus:outline-none focus:border-accent"
                />
              </div>
              <button
                className="btn btn-primary py-1 px-3 text-[12.5px] font-semibold"
                onClick={() => {
                  const newActId = `act_${Date.now()}`;
                  const newRuleId = `rule_${Date.now()}`;
                  setEditRule({
                    id: newRuleId,
                    activityId: newActId,
                    name: '',
                    color: 'blue',
                    conditions: [{ type: 'app_equals', value: '' }],
                    enabled: true,
                  });
                  setEditorOpen(true);
                }}
              >
                + Create Rule
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto relative">
            <table className="w-full text-[12.5px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr className="bg-secondary border-b border-default sticky top-0 z-10 select-none">
                  <th className="text-left font-bold px-4 py-2.5 cursor-pointer hover:text-default" style={{ color: 'var(--text-muted)' }} onClick={() => setRulesSortAsc(!rulesSortAsc)}>
                    <div className="flex items-center gap-1">
                      Activity Name <ArrowUpDown size={12} className="opacity-60" />
                    </div>
                  </th>
                  <th className="text-left font-bold px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>Match Rule</th>
                  <th className="text-left font-bold px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>Color</th>
                  <th className="text-left font-bold px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>Status</th>
                  <th className="text-right font-bold px-4 py-2.5" style={{ color: 'var(--text-muted)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRules.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-16 text-center text-muted">
                      <div className="flex flex-col items-center justify-center gap-1">
                        <Layers size={32} className="text-faint mb-1" />
                        <span className="font-semibold text-default">No tracking rules found</span>
                        <span className="text-[12px] text-faint">Create a rule or adjust your search filter.</span>
                      </div>
                    </td>
                  </tr>
                )}
                {filteredRules.map((rule) => {
                  const act = activities.find((a) => a.id === rule.activityId);
                  const colorObj = CURATED_COLORS.find((c) => c.name === act?.color) ?? CURATED_COLORS[0];
                  return (
                    <tr key={rule.id} className="border-b border-default hover:bg-hover transition-colors">
                      <td className="px-4 py-2.5 font-bold text-default">{act?.name ?? rule.activityId}</td>
                      <td className="px-4 py-2.5 text-muted font-semibold break-all">{conditionSummary(rule.conditions)}</td>
                      <td className="px-4 py-2.5">
                        <div style={{ width: 12, height: 12, borderRadius: '50%', background: colorObj.hex }} title={act?.color} />
                      </td>
                      <td className="px-4 py-2.5">
                        <input type="checkbox" checked={rule.enabled === 1} onChange={() => handleToggleRule(rule)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                      </td>
                      <td className="px-4 py-2.5 text-right space-x-2">
                        <button onClick={() => {
                          let conds = [];
                          try { conds = JSON.parse(rule.conditions); } catch {}
                          setEditRule({
                            id: rule.id,
                            activityId: rule.activityId,
                            name: act?.name ?? '',
                            color: act?.color ?? 'blue',
                            conditions: conds,
                            enabled: rule.enabled === 1,
                          });
                          setEditorOpen(true);
                        }} style={{ color: 'var(--accent)', cursor: 'pointer', fontWeight: 600 }}>
                          Edit
                        </button>
                        <button onClick={() => handleDuplicateRule(rule)} style={{ color: 'var(--text-muted)', cursor: 'pointer' }}>Duplicate</button>
                        <button onClick={() => handleDeleteRule(rule)} style={{ color: 'var(--danger)', cursor: 'pointer' }}>Delete</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Inline Rule Editor modal */}
      {editorOpen && editRule && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.4)', zIndex: 1000, display: 'flex', alignItems: 'center', padding: 24, justifyContent: 'center' }}>
          <div className="card space-y-5" style={{ width: '100%', maxWidth: '480px', padding: 24, animation: 'inspectorIn 140ms var(--ease-out)', boxShadow: 'var(--shadow-lg)' }}>
            <div>
              <h2 className="text-[18px] font-bold text-default">{editingRuleId ? 'Edit Tracking Rule' : 'Create Tracking Rule'}</h2>
              <p className="text-[12.5px] text-muted mt-0.5">
                Automatically associate matching session focus points with an activity and color.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-[12.5px] font-bold text-muted">Activity Name</label>
              <input
                type="text"
                value={editRule.name}
                onChange={(e) => setEditRule({ ...editRule, name: e.target.value })}
                placeholder="e.g. Coding, ChatGPT, Writing"
                className="w-full px-3 py-1.5 bg-default border border-default rounded-md text-[13px] text-default focus:outline-none focus:border-accent font-semibold"
              />
            </div>

            <div className="space-y-2">
              <label className="text-[12.5px] font-bold text-muted">Theme Color</label>
              <div className="flex gap-2 flex-wrap">
                {CURATED_COLORS.map((col) => (
                  <button
                    key={col.name}
                    title={col.name}
                    onClick={() => setEditRule({ ...editRule, color: col.name })}
                    style={{ width: 22, height: 22, borderRadius: '50%', background: col.hex, border: editRule.color === col.name ? '2px solid var(--text)' : '1px solid transparent', cursor: 'pointer', padding: 0 }}
                  />
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[12.5px] font-bold text-muted flex justify-between items-center">
                <span>Matching Conditions</span>
                <button onClick={() => setEditRule({ ...editRule, conditions: [...editRule.conditions, { type: 'app_equals', value: '' }] })} style={{ color: 'var(--accent)', fontSize: '12px', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>
                  + Add Condition
                </button>
              </label>

              <div className="space-y-2 max-h-[140px] overflow-y-auto pr-1">
                {editRule.conditions.length === 0 ? (
                  <div className="text-[12px] text-faint py-2 text-center bg-secondary rounded-lg border border-default">
                    No conditions defined. Match will not trigger.
                  </div>
                ) : (
                  editRule.conditions.map((cond, idx) => (
                    <div key={idx} className="flex gap-2 items-center">
                      <select
                        value={cond.type}
                        onChange={(e) => {
                          const nextConds = [...editRule.conditions];
                          nextConds[idx] = { ...cond, type: e.target.value };
                          setEditRule({ ...editRule, conditions: nextConds });
                        }}
                        style={{ background: 'var(--bg-secondary)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 6px', fontSize: '12px', outline: 'none' }}
                      >
                        <option value="app_equals">Application equals</option>
                        <option value="title_contains">Window Title contains</option>
                        <option value="url_contains">URL contains</option>
                        <option value="url_starts_with">URL starts with</option>
                        <option value="domain_equals">Domain equals</option>
                      </select>

                      <input
                        type="text"
                        value={cond.value}
                        onChange={(e) => {
                          const nextConds = [...editRule.conditions];
                          nextConds[idx] = { ...cond, value: e.target.value };
                          setEditRule({ ...editRule, conditions: nextConds });
                        }}
                        placeholder="match string"
                        style={{ flex: 1, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px', fontSize: '12.5px' }}
                      />

                      <button onClick={() => setEditRule({ ...editRule, conditions: editRule.conditions.filter((_, i) => i !== idx) })} style={{ color: 'var(--danger)', fontSize: '11px', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}>
                        Remove
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 select-none">
              <input type="checkbox" id="rule_enabled" checked={editRule.enabled} onChange={(e) => setEditRule({ ...editRule, enabled: e.target.checked })} style={{ accentColor: 'var(--accent)' }} />
              <label htmlFor="rule_enabled" style={{ fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}>Enable Rule</label>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-default" style={{ borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-secondary py-1.5 px-4 text-[12.5px]" onClick={handleCancelEditor}>Cancel</button>
              <button className="btn btn-primary py-1.5 px-4 text-[12.5px]" disabled={!editRule.name.trim()} onClick={handleSaveRule}>Save Rule</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function getEventNameAndType(e: TrackerEventDto): { name: string; type: 'App' | 'Website' } {
  if (e.url) {
    let urlStr = e.url.trim();
    if (!/^https?:\/\//i.test(urlStr)) {
      urlStr = 'https://' + urlStr;
    }
    try {
      const urlObj = new URL(urlStr);
      let host = urlObj.hostname;
      if (host.startsWith('www.')) host = host.slice(4);
      if (host) return { name: host, type: 'Website' };
    } catch {
      const match = e.url.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
      if (match && match[1]) return { name: match[1], type: 'Website' };
    }
  }
  return { name: e.app || 'Unknown App', type: 'App' };
}

function fmtTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function fmtHm(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function humanDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

function humanDurationShort(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

function conditionSummary(conditionsStr: string): string {
  try {
    const conds = JSON.parse(conditionsStr) as { type: string; value: string }[];
    if (conds.length === 0) return '(No conditions)';
    return conds.map((c) => {
      const typeLabel =
        c.type === 'app_equals'
          ? 'App ='
          : c.type === 'title_contains'
            ? 'Title contains'
            : c.type === 'url_contains'
              ? 'URL contains'
              : c.type === 'url_starts_with'
                ? 'URL starts with'
                : c.type === 'domain_equals'
                  ? 'Domain ='
                  : c.type;
      return `${typeLabel} "${c.value}"`;
    }).join(' AND ');
  } catch {
    return '(Invalid rule)';
  }
}
