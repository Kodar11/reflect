import { useEffect, useState, useCallback, useMemo } from 'react';
import { Search, Activity, Clock, ArrowUpDown, Layers, ExternalLink, Globe, Monitor, HelpCircle } from 'lucide-react';

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
  key: string; // name + '|' + type
  name: string;
  type: 'App' | 'Website';
  totalTime: number; // in ms
  sessionCount: number;
  lastUsed: Date;
  latestActivity: string;
  intervals: { startedAt: Date; endedAt: Date }[];
}

export function ActivityPage() {
  const [events, setEvents] = useState<TrackerEventDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Tab State: Events | Usage (persisted in localStorage)
  const [activeTab, setActiveTab] = useState<'events' | 'usage'>(() => {
    return (localStorage.getItem('reflect_activity_tab') as 'events' | 'usage') || 'events';
  });

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState('');
  const [usageSearchQuery, setUsageSearchQuery] = useState('');

  // Selected row state for Usage Details panel
  const [selectedUsageKey, setSelectedUsageKey] = useState<string | null>(null);

  // Usage tab sorting
  const [sortField, setSortField] = useState<'name' | 'type' | 'totalTime' | 'sessionCount' | 'lastUsed'>('totalTime');
  const [sortAsc, setSortAsc] = useState(false);

  // Persist tab selection
  useEffect(() => {
    localStorage.setItem('reflect_activity_tab', activeTab);
  }, [activeTab]);

  // Load events (poll every 3s to keep live)
  const load = useCallback(async () => {
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
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // Event Tab filter
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

  // Parse URLs and group events into applications vs websites
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

    // Sort intervals chronologically
    for (const row of map.values()) {
      row.intervals.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    }

    return Array.from(map.values());
  }, [events]);

  // Usage Tab filter & sort
  const filteredUsage = useMemo(() => {
    let list = usageData;
    if (usageSearchQuery.trim()) {
      const q = usageSearchQuery.toLowerCase();
      list = list.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          u.type.toLowerCase().includes(q)
      );
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

  // Selected Usage item (resolves from live data refresh)
  const selectedUsage = useMemo(() => {
    if (!selectedUsageKey) return null;
    return usageData.find((u) => u.key === selectedUsageKey) || null;
  }, [usageData, selectedUsageKey]);

  // Toggle sort order
  const handleSort = (field: typeof sortField) => {
    if (sortField === field) {
      setSortAsc((prev) => !prev);
    } else {
      setSortField(field);
      setSortAsc(false);
    }
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
              Analyze raw events captured today and examine aggregated application and website usage.
            </p>
          </div>
          {/* Tab Button Switcher */}
          <div className="flex bg-secondary p-1 rounded-lg border border-default">
            <button
              onClick={() => setActiveTab('events')}
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
              onClick={() => setActiveTab('usage')}
              className="px-4 py-1.5 rounded-md text-[13px] font-semibold transition-colors"
              style={{
                background: activeTab === 'usage' ? 'var(--bg)' : 'transparent',
                color: activeTab === 'usage' ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: activeTab === 'usage' ? 'var(--shadow-sm)' : 'none',
              }}
            >
              Usage
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
          {/* Search bar inside Events */}
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
                    <th
                      key={h}
                      className="text-left font-bold px-4 py-2.5 whitespace-nowrap"
                      style={{ color: 'var(--text-muted)' }}
                    >
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
                      <td className="px-4 py-2 whitespace-nowrap text-muted font-mono">
                        {fmtTime(started)}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap text-faint font-mono">
                        {dur}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap font-medium">{e.watcher}</td>
                      <td className="px-4 py-2 font-semibold text-default">{e.app ?? '—'}</td>
                      <td className="px-4 py-2 text-default truncate max-w-xs" title={e.title ?? ''}>{e.title ?? '—'}</td>
                      <td className="px-4 py-2 truncate max-w-xs">
                        {e.url ? (
                          <span className="text-[12px] text-accent font-mono truncate" title={e.url}>
                            {e.url}
                          </span>
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
      ) : (
        /* Usage Tab - Master-Detail side-by-side */
        <div className="flex gap-5 flex-1 min-h-[400px] h-[calc(100vh-14.5rem)] overflow-hidden">
          {/* Left Master Table */}
          <div className="card flex-1 overflow-hidden flex flex-col">
            {/* Table Search Header */}
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

            {/* Table wrapper */}
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
                        style={{
                          background: isSelected ? 'var(--bg-active)' : 'transparent',
                        }}
                        onMouseEnter={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                          if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent';
                        }}
                      >
                        <td className="px-4 py-2.5 font-semibold text-default flex items-center gap-2">
                          {u.type === 'Website' ? (
                            <Globe size={13} className="text-accent shrink-0" />
                          ) : (
                            <Monitor size={13} className="text-muted shrink-0" />
                          )}
                          <span className="truncate max-w-[200px]" title={u.name}>{u.name}</span>
                        </td>
                        <td className="px-4 py-2.5 text-muted">{u.type}</td>
                        <td className="px-4 py-2.5 font-bold font-mono text-default">
                          {humanDurationShort(u.totalTime)}
                        </td>
                        <td className="px-4 py-2.5 text-default font-mono">{u.sessionCount}</td>
                        <td className="px-4 py-2.5 text-faint font-mono">{fmtTime(u.lastUsed)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right Detail Card */}
          <div className="w-[340px] card overflow-hidden flex flex-col shrink-0">
            <div className="card-section border-b border-default bg-secondary py-3 flex items-center gap-2">
              <Activity size={14} className="text-muted" />
              <div className="text-[12px] uppercase tracking-wide text-muted font-bold">Usage Details</div>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              {selectedUsage ? (
                <div className="space-y-5 animate-fadeIn">
                  {/* Title Header */}
                  <div>
                    <span
                      className="chip font-semibold text-[11px]"
                      style={{
                        borderColor: selectedUsage.type === 'Website' ? 'var(--accent)' : 'var(--border-strong)',
                        color: selectedUsage.type === 'Website' ? 'var(--accent)' : 'var(--text)',
                      }}
                    >
                      {selectedUsage.type}
                    </span>
                    <h2 className="text-[18px] font-bold mt-2 text-default select-all break-all" title={selectedUsage.name}>
                      {selectedUsage.name}
                    </h2>
                  </div>

                  {/* Summary grid */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-secondary border border-default rounded-xl p-3">
                      <div className="text-[10px] text-muted uppercase font-bold tracking-wide">Total Time</div>
                      <div className="text-[16px] font-extrabold mt-1 text-default font-mono">
                        {humanDurationShort(selectedUsage.totalTime)}
                      </div>
                    </div>
                    <div className="bg-secondary border border-default rounded-xl p-3">
                      <div className="text-[10px] text-muted uppercase font-bold tracking-wide">Events Count</div>
                      <div className="text-[16px] font-extrabold mt-1 text-default font-mono">
                        {selectedUsage.sessionCount}
                      </div>
                    </div>
                  </div>

                  {/* Latest Activity details */}
                  <div className="bg-secondary border border-default rounded-xl p-3 space-y-1">
                    <div className="text-[10px] text-muted uppercase font-bold tracking-wide">Latest Activity</div>
                    <div className="text-[12.5px] font-semibold text-default break-words leading-snug" title={selectedUsage.latestActivity}>
                      {selectedUsage.latestActivity || '—'}
                    </div>
                    <div className="text-[10px] text-faint font-mono pt-1">
                      Last active at {fmtTime(selectedUsage.lastUsed)}
                    </div>
                  </div>

                  {/* Session intervals list */}
                  <div>
                    <div className="text-[11px] text-muted uppercase font-bold tracking-wide mb-2 flex items-center gap-1.5">
                      <Clock size={12} />
                      <span>Intervals ({selectedUsage.intervals.length})</span>
                    </div>
                    <div className="space-y-2 max-h-[180px] overflow-y-auto pr-1">
                      {selectedUsage.intervals.map((interval, idx) => {
                        const intervalDur = interval.endedAt.getTime() - interval.startedAt.getTime();
                        return (
                          <div
                            key={idx}
                            className="flex justify-between items-center text-[12px] bg-secondary px-3 py-2 rounded-lg border border-default"
                          >
                            <span className="font-mono text-muted">
                              {fmtHm(interval.startedAt)} – {fmtHm(interval.endedAt)}
                            </span>
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
      if (host.startsWith('www.')) {
        host = host.slice(4);
      }
      if (host) {
        return { name: host, type: 'Website' };
      }
    } catch {
      const match = e.url.match(/^(?:https?:\/\/)?(?:www\.)?([^\/:]+)/i);
      if (match && match[1]) {
        return { name: match[1], type: 'Website' };
      }
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
