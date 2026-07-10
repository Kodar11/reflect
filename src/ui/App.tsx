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
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
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
            <TimelinePage />
          ) : (
            <div className="max-w-5xl mx-auto px-6 sm:px-8 pt-10 pb-16 h-full overflow-y-auto">
              {route === 'sessions' ? (
                <SessionsPage />
              ) : route === 'activity' ? (
                <ActivityPage />
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
  return (
    <div className="space-y-6">
      <section className="card">
        <div className="card-section space-y-3">
          <div>
            <div className="text-[13px] uppercase tracking-wide text-muted font-semibold">Appearance</div>
            <h2 className="text-[20px] font-semibold mt-1">Theme</h2>
            <p className="text-[13.5px] text-muted mt-1">The starter keeps the theme system local and immediate.</p>
          </div>
          <ThemeToggle />
        </div>
      </section>

      <section className="card">
        <div className="card-section space-y-2">
          <div className="text-[15px] font-medium">Window behavior</div>
          <p className="text-[13.5px] text-muted">
            The header buttons control the frameless Electron window directly through the preload bridge.
          </p>
        </div>
      </section>
    </div>
  );
}

export default App;
