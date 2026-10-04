import { useEffect, useState } from 'react';
import { useThemeStore } from './store/themeStore';
import { useResolvedTheme } from './hooks/useResolvedTheme';
import { Sidebar, type Route } from './components/Sidebar';
import { Header } from './components/Header';
import { ThemeToggle } from './components/ThemeToggle';
import { ActivityPage } from './pages/Activity/ActivityPage';
import { SessionsPage } from './pages/SessionsPage';
import { TimelinePage } from './Timeline/TimelinePage';
import { useFocus } from './Focus/useFocus';
import { FocusPage } from './Focus/FocusPage';
import { FocusWidget } from './Focus/FocusWidget';
import { FocusSummaryModal } from './Focus/FocusSummaryModal';
import { OnboardingFlow } from './Onboarding/OnboardingFlow';
import { PersonalContextCard } from './Onboarding/PersonalContextCard';
import { LearnedPatternToast } from './components/LearnedPatternToast';
import { ReflectionPage } from './Reflection/ReflectionPage';
import { BackgroundControls } from './Settings/BackgroundControls';
import type { TimelineTarget } from './Reflection/reflectionView';
import type { FocusPrefill } from './Focus/FocusStart';
import { shouldShowOnboarding, type UserProfile } from '../profile/UserProfile';

type OnboardingGate =
  | { phase: 'loading' }
  | { phase: 'show'; profile: UserProfile }
  | { phase: 'hidden' };

function App() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  useResolvedTheme(theme);
  const focus = useFocus();

  const [route, setRoute] = useState<Route>('timeline');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activityTab, setActivityTab] = useState<'events' | 'usage' | 'rules'>('events');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [prefilledRule, setPrefilledRule] = useState<any | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingGate>({ phase: 'loading' });
  // Set when an evidence link in Reflection opens the Timeline at a specific
  // day / activity; cleared on ordinary navigation.
  const [timelineTarget, setTimelineTarget] = useState<(TimelineTarget & { nonce: number }) | null>(null);
  // Set when a coach recommendation is started as a Focus session.
  const [focusPrefill, setFocusPrefill] = useState<FocusPrefill | null>(null);
  // Set when the window was opened on a specific reflection (its notification).
  const [reflectionTarget, setReflectionTarget] = useState<{ anchor: string | null; nonce: number } | null>(null);

  // First-run onboarding: shown only while it hasn't been finished or skipped.
  // Any failure falls through to the normal app — onboarding never blocks it.
  useEffect(() => {
    window.userProfile
      .get()
      .then((profile) =>
        setOnboarding(shouldShowOnboarding(profile.onboardingStatus) ? { phase: 'show', profile } : { phase: 'hidden' }),
      )
      .catch((e) => {
        console.error('[App] failed to load user profile', e);
        setOnboarding({ phase: 'hidden' });
      });
  }, []);

  const PAGE_TITLES: Record<Route, string> = {
    timeline: 'Productivity Coach — Timeline',
    sessions: 'Productivity Coach — Sessions',
    activity: 'Productivity Coach — Activity',
    focus: 'Productivity Coach — Focus',
    reflection: 'Productivity Coach — Reflection',
    settings: 'Productivity Coach — Settings',
  };

  const focusActive = focus.activeSession !== null;
  const focusTask = focus.activeSession?.session.task ?? null;
  useEffect(() => {
    document.title = focusTask ? `Focus — ${focusTask}` : PAGE_TITLES[route] ?? 'Productivity Coach';
  }, [route, focusTask]);

  // Ctrl+Shift+F opens Focus from anywhere. Pausing (Space) is handled on the
  // Focus page itself; no shortcut ends a session.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setRoute('focus');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // The end-of-day notification opens the Reflection tab.
  useEffect(() => {
    const open = () => setRoute('reflection');
    window.reflection.onOpenRequested(open);
    return () => window.reflection.offOpenRequested(open);
  }, []);

  // The tray, the widget and notifications open this window at a specific
  // place. The request waits in the main process — this window may only just
  // have been created — and is collected on mount and whenever one arrives.
  const requestFocusIntent = focus.requestIntent;
  useEffect(() => {
    let cancelled = false;
    const collect = () => {
      // A request is handed out once: a listener that is no longer current must not take it.
      if (cancelled) return;
      window.background
        .takeNavigation()
        .then((target) => {
          // Once taken, a request is always applied — also if this effect was
          // re-run meanwhile (React's development double-mount). The request
          // exists only here now; dropping it would lose the navigation.
          if (!target) return;
          if (target.route === 'settings') setRoute('settings');
          else if (target.route === 'focus') requestFocusIntent(target.intent);
          else {
            setReflectionTarget({ anchor: target.anchor, nonce: Date.now() });
            setRoute('reflection');
          }
        })
        .catch((e) => console.error('[App] failed to read the navigation request', e));
    };
    collect();
    const subscription = window.background.onNavigationRequested(collect);
    return () => {
      cancelled = true;
      window.background.offNavigationRequested(subscription);
    };
  }, [requestFocusIntent]);

  // The tray's Focus entries bring the Focus page forward; the page then
  // opens the requested flow.
  useEffect(() => {
    if (focus.intent) setRoute('focus');
  }, [focus.intent]);

  // A Focus band in the Timeline: the running session opens the Focus page,
  // a past one shows its summary in place.
  const openFocusSession = (sessionId: string) => {
    if (focus.activeSession?.session.id === sessionId) setRoute('focus');
    else void focus.showSummaryFor(sessionId);
  };

  const handleNavigate = (r: Route) => {
    setRoute(r);
    setTimelineTarget(null);
    setFocusPrefill(null);
    setReflectionTarget(null);
  };

  return (
    <div className="min-h-screen surface text-default">
      <Header
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        showSidebarToggle={onboarding.phase === 'hidden'}
      />
      {onboarding.phase === 'loading' ? (
        <div className="h-[calc(100vh-2.75rem)]" />
      ) : onboarding.phase === 'show' ? (
        <main className="h-[calc(100vh-2.75rem)] overflow-y-auto">
          <div className="min-h-full flex flex-col justify-center px-6 py-10">
            <OnboardingFlow
              mode="onboarding"
              initialProfile={onboarding.profile}
              onExit={() => setOnboarding({ phase: 'hidden' })}
            />
          </div>
        </main>
      ) : (
        <div className="flex h-[calc(100vh-2.75rem)]">
          <Sidebar
            route={route}
            onNavigate={handleNavigate}
            open={sidebarOpen}
          />
          <main className="flex-1 min-w-0 h-full overflow-hidden">
            {route === 'timeline' ? (
              <TimelinePage
                focus={focus}
                navigationTarget={timelineTarget}
                onNavigateToFocus={openFocusSession}
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
            ) : route === 'focus' ? (
              <FocusPage focus={focus} prefill={focusPrefill} onPrefillConsumed={() => setFocusPrefill(null)} />
            ) : route === 'reflection' ? (
              <ReflectionPage
                target={reflectionTarget}
                onViewTimeline={(target) => {
                  setTimelineTarget({ ...target, nonce: Date.now() });
                  setRoute('timeline');
                }}
                // Focus is the one execution mechanism: a recommendation is run
                // through the ordinary start flow, with what and how long filled in.
                onStartFocus={(action) => {
                  if (!focus.activeSession) {
                    setFocusPrefill({
                      task: action.focusTask ?? action.title,
                      minutes: action.focusMinutes,
                      actionId: action.id,
                      nonce: Date.now(),
                    });
                  }
                  setRoute('focus');
                }}
              />
            ) : route === 'settings' ? (
              <div className="max-w-5xl mx-auto px-6 sm:px-8 pt-10 pb-16 h-full overflow-y-auto">
                <SettingsPage theme={theme} setTheme={setTheme} />
              </div>
            ) : (
              <div className="max-w-5xl mx-auto px-6 sm:px-8 pt-10 pb-16 h-full overflow-y-auto">
                <SessionsPage />
              </div>
            )}
          </main>
        </div>
      )}

      {focus.activeSession && focusActive && route !== 'focus' && onboarding.phase === 'hidden' && (
        <FocusWidget session={focus.activeSession} onOpen={() => setRoute('focus')} />
      )}

      {onboarding.phase === 'hidden' && <LearnedPatternToast />}

      {focus.summary && (
        <FocusSummaryModal
          summary={focus.summary}
          onClose={focus.dismissSummary}
        />
      )}
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
  const [editingContext, setEditingContext] = useState<UserProfile | null>(null);

  if (editingContext) {
    return (
      <OnboardingFlow
        mode="edit"
        initialProfile={editingContext}
        onExit={() => setEditingContext(null)}
      />
    );
  }

  return (
    <div className="space-y-8" style={{ animation: 'fadeIn 180ms var(--ease-out)' }}>
      <div>
        <h1 className="text-[28px] font-extrabold tracking-tight">Settings</h1>
        <p className="text-[14px] text-muted mt-1">Configure how Reflect runs, appearance preferences and export your tracking databases.</p>
      </div>

      {/* Background & Tracking Section */}
      <section className="space-y-4">
        <div className="border-b border-default pb-2">
          <h2 className="text-[18px] font-bold">Background &amp; Tracking</h2>
          <p className="text-[13px] text-muted mt-1">
            Reflect works in the background. You do not need to keep this window open — closing it leaves Reflect running in the system tray.
          </p>
        </div>
        <BackgroundControls variant="settings" />
      </section>

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

      {/* Personal Context Section */}
      <section className="space-y-4">
        <h2 className="text-[18px] font-bold border-b border-default pb-2">Personalization</h2>
        <PersonalContextCard onEdit={setEditingContext} />
      </section>

      {/* Data Section */}
      <section className="space-y-4">
        <h2 className="text-[18px] font-bold border-b border-default pb-2">Data</h2>

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
