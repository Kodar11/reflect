import { useEffect, useState } from 'react';
import { useThemeStore } from './store/themeStore';
import { useResolvedTheme } from './hooks/useResolvedTheme';
import { Sidebar, type Route } from './components/Sidebar';
import { Header } from './components/Header';
import { APP_VERSION } from './lib/version';
import { ThemeToggle } from './components/ThemeToggle';
import { EventsPage } from './pages/EventsPage';
import { SessionsPage } from './pages/SessionsPage';

function App() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  useResolvedTheme(theme);

  const [route, setRoute] = useState<Route>('overview');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  
  const PAGE_TITLES: Record<Route, string> = {
    overview: 'Productivity Coach',
    sessions: 'Productivity Coach — Sessions',
    events: 'Productivity Coach — Event Viewer',
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
      <div className="flex">
        <Sidebar
          route={route}
          onNavigate={setRoute}
          open={sidebarOpen}
        />
        <main className="flex-1 min-w-0">
          <div className="max-w-5xl mx-auto px-6 sm:px-8 pt-10 pb-16">
            {route === 'overview' ? (
              <OverviewPage />
            ) : route === 'sessions' ? (
              <SessionsPage />
            ) : route === 'events' ? (
              <EventsPage />
            ) : (
              <SettingsPage theme={theme} setTheme={setTheme} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function OverviewPage() {
  return (
    <div className="space-y-6">
      <section className="card overflow-hidden">
        <div className="card-section flex items-start justify-between gap-6">
          <div>
            <div className="text-[13px] uppercase tracking-wide text-muted">Starter shell</div>
            <h1 className="text-[28px] font-semibold tracking-tight mt-1">Productivity Coach</h1>
            <p className="text-[13.5px] text-muted mt-2 max-w-2xl">
              A clean Electron foundation for the next product stage. The current shell keeps the desktop UI, window controls, theme system, and app packaging in place while the legacy product logic has been removed.
            </p>
          </div>
          <div className="shrink-0">
            <div className="chip">v{APP_VERSION}</div>
          </div>
        </div>
      </section>

      <div className="grid gap-3 md:grid-cols-3">
        <InfoCard title="Electron" description="Frameless desktop shell with preload bridge and window controls." />
        <InfoCard title="React + TypeScript" description="Renderer entrypoint, shared styling, and typed UI scaffold." />
        <InfoCard title="Ready for expansion" description="Routing, theme persistence, and packaging remain in place for the next feature set." />
      </div>

      <section className="card">
        <div className="card-section space-y-3">
          <div className="text-[15px] font-medium">What is kept</div>
          <ul className="space-y-2 text-[13.5px] text-muted list-disc pl-5">
            <li>Desktop window management and close/minimize/maximize actions.</li>
            <li>The UI shell, layout chrome, and theme switcher.</li>
            <li>Build, packaging, and Electron preload infrastructure.</li>
            <li>Generic logging for the main process.</li>
          </ul>
        </div>
      </section>
    </div>
  );
}

function SettingsPage(props: { theme: string; setTheme: (theme: any) => void }) {
  return (
    <div className="space-y-6">
      <section className="card">
        <div className="card-section space-y-3">
          <div>
            <div className="text-[13px] uppercase tracking-wide text-muted">Appearance</div>
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

function InfoCard(props: { title: string; description: string }) {
  return (
    <section className="card">
      <div className="card-section space-y-2">
        <div className="text-[15px] font-medium">{props.title}</div>
        <p className="text-[13.25px] text-muted leading-relaxed">{props.description}</p>
      </div>
    </section>
  );
}

export default App;
