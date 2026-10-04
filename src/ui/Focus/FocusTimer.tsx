import { useEffect, useState } from 'react';
import { timerView } from './focusView';

/**
 * Re-renders itself a few times a second and derives what to show from the
 * session's timestamps. The repaint interval is local to this component, so
 * the rest of the page does not re-render every tick, and the value cannot
 * drift: the backend's timestamps are the only source of truth.
 */
export function useFocusClock(session: ActiveFocusSessionDto) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [session.session.id, session.isRunning, session.plannedEndsAt]);

  return timerView(session, now);
}

export function FocusTimer({ session }: { session: ActiveFocusSessionDto }) {
  const view = useFocusClock(session);
  // Paused: the timer is frozen, and dimmed to show it.
  const dim = !session.isRunning;

  return (
    <div>
      <div className="focus-clock" data-dim={dim} role="timer" aria-label={`${view.clock} ${view.label}`}>
        {view.clock}
      </div>
      <div className="focus-clock-label">{view.label}</div>
    </div>
  );
}
