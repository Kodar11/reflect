import { useEffect, useState } from 'react';
import { useThemeStore } from './store/themeStore';
import { useResolvedTheme } from './hooks/useResolvedTheme';
import { Sidebar, type Route } from './components/Sidebar';
import { Header } from './components/Header';
import { ThemeToggle } from './components/ThemeToggle';
import { ActivityPage } from './pages/ActivityPage';
import { SessionsPage } from './pages/SessionsPage';
import { TimelinePage } from './Timeline/TimelinePage';

function App() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  useResolvedTheme(theme);

  const [route, setRoute] = useState<Route>('timeline');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<'events' | 'usage' | 'rules'>('events');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [prefilledRule, setPrefilledRule] = useState<any | null>(null);
  
  const PAGE_TITLES: Record<Route, string> = {
    timeline: 'Productivity Coach — Timeline',
    sessions: 'Productivity Coach — Sessions',
    activity: 'Productivity Coach — Activity',
    settings: 'Productivity Coach — Settings',
  };

  useEffect(() => {
    document.title = PAGE_TITLES[route] ?? 'Productivity Coach';
  }, [route]);

  return (
    <div className="min-h-screen surface text-default">
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        showSidebarToggle={true}
      />
      <div className="flex h-[calc(100vh-2.75rem)]">
        <Sidebar
          route={route}
          onNavigate={setRoute}
          open={sidebarOpen}
        />
        <main className="flex-1 min-w-0 h-full overflow-hidden">
          {route === 'timeline' ? (
            <TimelinePage
              onNavigateToRule={(ruleId) => {
                setRoute('activity');
                setActivityTab('rules');
                setEditingRuleId(ruleId);
                setPrefilledRule(null);
              }}
              onCreateRuleFromSession={(session) => {
                setRoute('activity');
                setActivityTab('rules');
                setPrefilledRule(session);
                setEditingRuleId(null);
              }}
            />
          ) : route === 'activity' ? (
            <div className="px-6 py-4 h-full overflow-hidden flex flex-col">
              <ActivityPage
                activeTab={activityTab}
                onTabChange={setActivityTab}
                editingRuleId={editingRuleId}
                setEditingRuleId={setEditingRuleId}
                prefilledRule={prefilledRule}
                setPrefilledRule={setPrefilledRule}
              />
            </div>
          ) : (
            <div className="max-w-5xl mx-auto px-6 sm:px-8 pt-10 pb-16 h-full overflow-y-auto">
              {route === 'sessions' ? (
                <SessionsPage />
              ) : (
                <SettingsPage theme={theme} setTheme={setTheme} />
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function SettingsPage(props: { theme: string; setTheme: (theme: any) => void }) {
  const [status, setStatus] = useState<{ type: 'idle' | 'loading' | 'success' | 'error'; message: string }>({ type: 'idle', message: '' });

  const runExport = async (name: string, fn: () => Promise<{ success: boolean; cancelled?: boolean; filePath?: string; error?: string }>) => {
    setStatus({ type: 'loading', message: `Exporting ${name}...` });
    try {
      const res = await fn();
      if (res.success && res.filePath) {
        const parts = res.filePath.split(/[\\/]/);
        const filename = parts[parts.length - 1];
        setStatus({ type: 'success', message: `Successfully exported to ${filename}` });
      } else if (res.cancelled) {
        setStatus({ type: 'idle', message: '' });
      } else {
        setStatus({ type: 'error', message: `Export failed: ${res.error ?? 'Unknown error'}` });
      }
    } catch (e) {
      setStatus({ type: 'error', message: `Export failed: ${(e as Error)?.message ?? String(e)}` });
    }
  };

  const isBtnDisabled = status.type === 'loading';

  return (
    <div className="space-y-8" style={{ animation: 'fadeIn 180ms var(--ease-out)' }}>
      <div>
        <h1 className="text-[28px] font-extrabold tracking-tight">Settings</h1>
        <p className="text-[14px] text-muted mt-1">Configure appearance preferences and export your tracking databases.</p>
      </div>

      {/* Appearance Section */}
      <section className="space-y-4">
        <h2 className="text-[18px] font-bold border-b border-default pb-2">Appearance</h2>
        <div className="card">
          <div className="card-section space-y-3">
            <div>
              <div className="text-[15px] font-semibold">Theme</div>
              <p className="text-[13px] text-muted mt-1">Switch between dark mode, light mode, or system default colors.</p>
            </div>
            <ThemeToggle />
          </div>
        </div>
      </section>

      {/* Data Section */}
      <section className="space-y-4">
        <h2 className="text-[18px] font-bold border-b border-default pb-2">Data</h2>
        
        {/* Status Alert Banner */}
        {status.type !== 'idle' && (
          <div
            style={{
              padding: '12px 16px',
              borderRadius: 8,
              fontSize: '13px',
              fontWeight: 500,
              background:
                status.type === 'loading'
                  ? 'var(--bg-secondary)'
                  : status.type === 'success'
                    ? 'rgba(35, 130, 226, 0.08)'
                    : 'rgba(239, 68, 68, 0.08)',
              border: `1px solid ${
                status.type === 'loading'
                  ? 'var(--border)'
                  : status.type === 'success'
                    ? 'var(--accent)'
                    : 'var(--danger)'
              }`,
              color:
                status.type === 'loading'
                  ? 'var(--text-muted)'
                  : status.type === 'success'
                    ? 'var(--accent)'
                    : 'var(--danger)',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {status.type === 'loading' && <span style={{ animation: 'spin 1s linear infinite' }}>◌</span>}
            <span>{status.message}</span>
          </div>
        )}

        <div className="space-y-3">
          {/* Timeline Export Card */}
          <div className="card flex items-center justify-between p-5">
            <div>
              <div className="text-[15px] font-semibold">Export Timeline</div>
              <p className="text-[13px] text-muted mt-0.5">Contains sessions, offline records, custom titles, notes, and resolved edits.</p>
            </div>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary py-1.5 px-4"
                disabled={isBtnDisabled}
                onClick={() => runExport('Timeline', () => window.settings.exportTimeline('csv'))}
              >
                CSV
              </button>
              <button
                className="btn btn-secondary py-1.5 px-4"
                disabled={isBtnDisabled}
                onClick={() => runExport('Timeline', () => window.settings.exportTimeline('json'))}
              >
                JSON
              </button>
            </div>
          </div>

          {/* Activity Export Card */}
          <div className="card flex items-center justify-between p-5">
            <div>
              <div className="text-[15px] font-semibold">Export Activity</div>
              <p className="text-[13px] text-muted mt-0.5">Contains raw captured device events including timestamps, application names, and window titles.</p>
            </div>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary py-1.5 px-4"
                disabled={isBtnDisabled}
                onClick={() => runExport('Activity', () => window.settings.exportActivity('csv'))}
              >
                CSV
              </button>
              <button
                className="btn btn-secondary py-1.5 px-4"
                disabled={isBtnDisabled}
                onClick={() => runExport('Activity', () => window.settings.exportActivity('json'))}
              >
                JSON
              </button>
            </div>
          </div>

          {/* Sessions Export Card */}
          <div className="card flex items-center justify-between p-5">
            <div>
              <div className="text-[15px] font-semibold">Export Sessions</div>
              <p className="text-[13px] text-muted mt-0.5">Contains auto-generated focus session spans before applying custom timeline user edits.</p>
            </div>
            <div className="flex gap-2">
              <button
                className="btn btn-secondary py-1.5 px-4"
                disabled={isBtnDisabled}
                onClick={() => runExport('Sessions', () => window.settings.exportSessions('csv'))}
              >
                CSV
              </button>
              <button
                className="btn btn-secondary py-1.5 px-4"
                disabled={isBtnDisabled}
                onClick={() => runExport('Sessions', () => window.settings.exportSessions('json'))}
              >
                JSON
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default App;
