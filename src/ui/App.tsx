import { useEffect, useState } from 'react';
import { useThemeStore } from './store/themeStore';
import { useResolvedTheme } from './hooks/useResolvedTheme';
import { Sidebar, type Route } from './components/Sidebar';
import { Header } from './components/Header';
import { ActivityPage } from './pages/Activity/ActivityPage';
import { SessionsPage } from './pages/SessionsPage';
import { TimelinePage } from './Timeline/TimelinePage';
import { useFocus } from './Focus/useFocus';
import { FocusPage } from './Focus/FocusPage';
import { FocusWidget } from './Focus/FocusWidget';
import { FocusSummaryModal } from './Focus/FocusSummaryModal';
import { OnboardingFlow } from './Onboarding/OnboardingFlow';
import { LearnedPatternToast } from './components/LearnedPatternToast';
import { ReflectionPage } from './Reflection/ReflectionPage';
import { SettingsPage } from './Settings/SettingsPage';
import type { TimelineTarget } from './Reflection/reflectionView';
import type { FocusPrefill } from './Focus/FocusStart';
import { shouldShowOnboarding, type UserProfile } from '../profile/UserProfile';

type OnboardingGate =
  | { phase: 'loading' }
  | { phase: 'show'; profile: UserProfile }
  | { phase: 'hidden' };

function App() {
  const theme = useThemeStore((s) => s.theme);
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
                onOpenSettings={() => handleNavigate('settings')}
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
              <div className="h-full overflow-y-auto settings-scroll">
                <div className="max-w-3xl mx-auto px-6 sm:px-8 pt-10 pb-16">
                  <SettingsPage />
                </div>
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

export default App;
