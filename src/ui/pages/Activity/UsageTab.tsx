import { useMemo, useState } from 'react';
import { Search, Clock, Monitor, Globe, Activity } from 'lucide-react';
import type { TrackerEventDto, UsageRow } from './activityTypes';
import { AppIcon, WebsiteFavicon } from './ActivityIcons';
import { buildUsageData, fmtHm, fmtTime, humanDuration, humanDurationShort } from './activityUtils';

interface UsageTabProps {
  events: TrackerEventDto[];
}

export function UsageTab({ events }: UsageTabProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sortField, setSortField] = useState<'name' | 'type' | 'totalTime' | 'sessionCount' | 'lastUsed'>('totalTime');
  const [sortAsc, setSortAsc] = useState(false);

  const usageData = useMemo(() => buildUsageData(events), [events]);

  const totalTrackedTime = useMemo(
    () => usageData.reduce((sum, u) => sum + u.totalTime, 0),
    [usageData],
  );

  const topUsageList = useMemo(
    () => [...usageData].sort((a, b) => b.totalTime - a.totalTime).slice(0, 5),
    [usageData],
  );

  const filteredUsage = useMemo(() => {
    let list = usageData;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((u) => u.name.toLowerCase().includes(q) || u.type.toLowerCase().includes(q));
    }

    return [...list].sort((a, b) => {
      let valA: any = a[sortField];
      let valB: any = b[sortField];

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
  }, [usageData, searchQuery, sortField, sortAsc]);

  const applications = useMemo(
    () => filteredUsage.filter((u) => u.type === 'App'),
    [filteredUsage],
  );
  const websites = useMemo(
    () => filteredUsage.filter((u) => u.type === 'Website'),
    [filteredUsage],
  );

  const selectedUsage = useMemo(() => {
    if (!selectedKey) return null;
    return usageData.find((u) => u.key === selectedKey) || null;
  }, [usageData, selectedKey]);

  const todaySummary = useMemo(() => {
    const apps = usageData.filter((u) => u.type === 'App');
    const sites = usageData.filter((u) => u.type === 'Website');
    const mostUsedApp = [...apps].sort((a, b) => b.totalTime - a.totalTime)[0] ?? null;
    const mostUsedSite = [...sites].sort((a, b) => b.totalTime - a.totalTime)[0] ?? null;
    const mostOpenedApp = [...apps].sort((a, b) => b.sessionCount - a.sessionCount)[0] ?? null;
    const mostOpenedSite = [...sites].sort((a, b) => b.sessionCount - a.sessionCount)[0] ?? null;
    return {
      totalApps: apps.length,
      totalSites: sites.length,
      mostUsedApp,
      mostUsedSite,
      mostOpenedApp,
      mostOpenedSite,
    };
  }, [usageData]);

  const renderUsageRow = (u: UsageRow) => {
    const isSelected = selectedKey === u.key;
    const pct = totalTrackedTime > 0 ? (u.totalTime / totalTrackedTime) * 100 : 0;

    return (
      <div
        key={u.key}
        onClick={() => setSelectedKey(u.key)}
        className="flex items-center justify-between p-2 rounded-lg border border-default cursor-pointer transition-colors"
        style={{
          background: isSelected ? 'var(--bg-active)' : 'var(--bg)',
          borderColor: isSelected ? 'var(--accent)' : 'var(--border)',
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            e.currentTarget.style.background = 'var(--bg-hover)';
            e.currentTarget.style.borderColor = 'var(--border-strong)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            e.currentTarget.style.background = 'var(--bg)';
            e.currentTarget.style.borderColor = 'var(--border)';
          }
        }}
      >
        <div className="flex items-center gap-3 min-w-0 flex-1 pr-4">
          <div className="shrink-0 flex items-center justify-center">
            {u.type === 'Website' ? <WebsiteFavicon domain={u.name} size={16} /> : <AppIcon appName={u.name} size={16} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-default text-[13px] truncate" title={u.name}>
              {u.name}
            </div>
            <div className="flex items-center gap-2 mt-0.5">
              <div style={{ flex: 1, height: '4px', background: 'var(--border)', borderRadius: '2px', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(1, pct)}%`, height: '100%', background: 'var(--accent)', borderRadius: '2px' }} />
              </div>
              <span className="text-[10px] text-muted font-bold shrink-0">{pct.toFixed(0)}%</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 text-right shrink-0">
          <div>
            <div className="font-bold text-default text-[13px] font-mono">{humanDurationShort(u.totalTime)}</div>
            <div className="text-[10px] text-faint font-semibold mt-0.5">
              {u.sessionCount} session{u.sessionCount === 1 ? '' : 's'}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="relative w-64">
        <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-muted">
          <Search size={13} />
        </span>
        <input
          type="text"
          placeholder="Search apps/sites..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full pr-3 py-1 bg-default border border-default rounded-md text-[12.5px] text-default placeholder-muted focus:outline-none focus:border-accent"
          style={{ paddingLeft: '28px' }}
        />
      </div>

      <div className="flex gap-4 flex-1 min-h-0 overflow-hidden">
        <div className="flex-1 overflow-hidden flex flex-col space-y-3">
          <div className="card bg-secondary p-3 border border-default rounded-xl">
            <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Clock size={11} />
              <span>Top Usage Today</span>
            </div>
            <div className="flex gap-3 overflow-x-auto py-0.5">
              {topUsageList.map((u) => (
                <div
                  key={u.key}
                  onClick={() => setSelectedKey(u.key)}
                  className="flex items-center gap-2 bg-default border border-default px-2.5 py-1 rounded-lg cursor-pointer hover:bg-hover hover:border-strong transition-colors shrink-0"
                  style={{ borderColor: selectedKey === u.key ? 'var(--accent)' : 'var(--border)' }}
                >
                  {u.type === 'Website' ? <WebsiteFavicon domain={u.name} size={13} /> : <AppIcon appName={u.name} size={13} />}
                  <span className="font-semibold text-default text-[12px] truncate max-w-[100px]">{u.name}</span>
                  <span className="font-mono text-muted text-[11px] font-bold">{humanDurationShort(u.totalTime)}</span>
                </div>
              ))}
              {topUsageList.length === 0 && (
                <span className="text-[11px] text-faint">No usage records for today.</span>
              )}
            </div>
          </div>

          <div className="card flex-1 overflow-y-auto p-4 space-y-5 rounded-xl border border-default">
            <div className="space-y-2">
              <h3 className="text-[11px] font-bold text-muted uppercase tracking-wider border-b border-default pb-1 flex items-center gap-1.5">
                <Monitor size={12} className="text-muted" />
                <span>Applications ({applications.length})</span>
              </h3>
              {applications.length === 0 ? (
                <div className="text-[11.5px] text-faint py-4 text-center bg-secondary rounded-lg border border-dashed border-default">
                  No applications tracked today.
                </div>
              ) : (
                <div className="space-y-1.5">{applications.map((u) => renderUsageRow(u))}</div>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-[11px] font-bold text-muted uppercase tracking-wider border-b border-default pb-1 flex items-center gap-1.5">
                <Globe size={12} className="text-muted" />
                <span>Websites ({websites.length})</span>
              </h3>
              {websites.length === 0 ? (
                <div className="text-[11.5px] text-faint py-4 text-center bg-secondary rounded-lg border border-dashed border-default">
                  No websites visited today.
                </div>
              ) : (
                <div className="space-y-1.5">{websites.map((u) => renderUsageRow(u))}</div>
              )}
            </div>
          </div>
        </div>

        <div className="w-[320px] card overflow-hidden flex flex-col shrink-0 rounded-xl border border-default">
          <div className="card-section border-b border-default bg-secondary py-2 px-4 flex items-center gap-2">
            <Activity size={13} className="text-muted" />
            <div className="text-[11px] uppercase tracking-wide text-muted font-bold">Details</div>
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {selectedUsage ? (
              <div className="space-y-4 animate-fadeIn">
                <div>
                  <span
                    className="chip font-semibold text-[10px]"
                    style={{
                      borderColor: selectedUsage.type === 'Website' ? 'var(--accent)' : 'var(--border-strong)',
                      color: selectedUsage.type === 'Website' ? 'var(--accent)' : 'var(--text)',
                    }}
                  >
                    {selectedUsage.type}
                  </span>
                  <h2
                    className="text-[18px] font-extrabold mt-1.5 text-default select-all break-all leading-tight"
                    title={selectedUsage.name}
                  >
                    {selectedUsage.name}
                  </h2>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <div className="bg-secondary border border-default rounded-xl p-3">
                    <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Tracked Duration</div>
                    <div className="text-[15px] font-extrabold mt-1 text-default font-mono">{humanDurationShort(selectedUsage.totalTime)}</div>
                  </div>
                  <div className="bg-secondary border border-default rounded-xl p-3">
                    <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Sessions count</div>
                    <div className="text-[15px] font-extrabold mt-1 text-default font-mono">{selectedUsage.sessionCount}</div>
                  </div>
                </div>

                <div className="bg-secondary border border-default rounded-xl p-3 space-y-1">
                  <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Latest Window Title</div>
                  <div className="text-[12px] font-semibold text-default break-words leading-tight" title={selectedUsage.latestActivity}>
                    {selectedUsage.latestActivity || '—'}
                  </div>
                  <div className="text-[9.5px] text-faint font-mono pt-0.5 font-bold">Active at {fmtTime(selectedUsage.lastUsed)}</div>
                </div>

                <div>
                  <div className="text-[10px] text-muted uppercase font-bold tracking-wide mb-2 flex items-center gap-1.5">
                    <Clock size={11} />
                    <span>Intervals ({selectedUsage.intervals.length})</span>
                  </div>
                  <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
                    {selectedUsage.intervals.map((interval, idx) => {
                      const intervalDur = interval.endedAt.getTime() - interval.startedAt.getTime();
                      return (
                        <div
                          key={idx}
                          className="flex justify-between items-center text-[11.5px] bg-secondary px-2.5 py-1.5 rounded-lg border border-default"
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

                <div className="pt-2 border-t border-default flex justify-end">
                  <button
                    onClick={() => setSelectedKey(null)}
                    className="text-[11.5px] text-accent font-semibold hover:underline"
                  >
                    Clear selection
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4 animate-fadeIn">
                <div>
                  <span className="text-[10px] text-muted uppercase font-bold tracking-wider">Dashboard</span>
                  <h2 className="text-[18px] font-extrabold mt-1 text-default">Today&apos;s Summary</h2>
                </div>

                <div className="space-y-2.5">
                  <div className="bg-secondary border border-default rounded-xl p-3">
                    <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Total Tracked Time</div>
                    <div className="text-[18px] font-extrabold mt-0.5 text-accent font-mono">{humanDurationShort(totalTrackedTime)}</div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="bg-secondary border border-default rounded-xl p-3">
                      <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Applications</div>
                      <div className="text-[15px] font-extrabold mt-0.5 text-default font-mono">{todaySummary.totalApps}</div>
                    </div>
                    <div className="bg-secondary border border-default rounded-xl p-3">
                      <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Websites</div>
                      <div className="text-[15px] font-extrabold mt-0.5 text-default font-mono">{todaySummary.totalSites}</div>
                    </div>
                  </div>

                  {todaySummary.mostUsedApp && (
                    <div className="bg-secondary border border-default rounded-xl p-3 flex justify-between items-center gap-2">
                      <div className="min-w-0">
                        <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Most Used App</div>
                        <div className="text-[12.5px] font-bold text-default truncate mt-0.5" style={{ maxWidth: '140px' }} title={todaySummary.mostUsedApp.name}>
                          {todaySummary.mostUsedApp.name}
                        </div>
                      </div>
                      <span className="font-bold text-default text-[12.5px] font-mono shrink-0">{humanDurationShort(todaySummary.mostUsedApp.totalTime)}</span>
                    </div>
                  )}

                  {todaySummary.mostUsedSite && (
                    <div className="bg-secondary border border-default rounded-xl p-3 flex justify-between items-center gap-2">
                      <div className="min-w-0">
                        <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Most Used Website</div>
                        <div className="text-[12.5px] font-bold text-default truncate mt-0.5" style={{ maxWidth: '140px' }} title={todaySummary.mostUsedSite.name}>
                          {todaySummary.mostUsedSite.name}
                        </div>
                      </div>
                      <span className="font-bold text-default text-[12.5px] font-mono shrink-0">{humanDurationShort(todaySummary.mostUsedSite.totalTime)}</span>
                    </div>
                  )}

                  {todaySummary.mostOpenedApp && (
                    <div className="bg-secondary border border-default rounded-xl p-3 flex justify-between items-center gap-2">
                      <div className="min-w-0">
                        <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Most Opened App</div>
                        <div className="text-[12.5px] font-bold text-default truncate mt-0.5" style={{ maxWidth: '140px' }} title={todaySummary.mostOpenedApp.name}>
                          {todaySummary.mostOpenedApp.name}
                        </div>
                      </div>
                      <span className="text-muted text-[11px] font-bold shrink-0">{todaySummary.mostOpenedApp.sessionCount} times</span>
                    </div>
                  )}

                  {todaySummary.mostOpenedSite && (
                    <div className="bg-secondary border border-default rounded-xl p-3 flex justify-between items-center gap-2">
                      <div className="min-w-0">
                        <div className="text-[9.5px] text-muted uppercase font-bold tracking-wide">Most Opened Website</div>
                        <div className="text-[12.5px] font-bold text-default truncate mt-0.5" style={{ maxWidth: '140px' }} title={todaySummary.mostOpenedSite.name}>
                          {todaySummary.mostOpenedSite.name}
                        </div>
                      </div>
                      <span className="text-muted text-[11px] font-bold shrink-0">{todaySummary.mostOpenedSite.sessionCount} times</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
