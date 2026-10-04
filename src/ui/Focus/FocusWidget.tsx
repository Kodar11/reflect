import { useFocusClock } from './FocusTimer';

interface FocusWidgetProps {
  session: ActiveFocusSessionDto;
  onOpen: () => void;
}

/**
 * A quiet reminder shown on other pages while Focus is running. It only
 * links back to the Focus page: pausing and ending live there, behind their
 * deliberate flows.
 */
export function FocusWidget({ session, onOpen }: FocusWidgetProps) {
  const view = useFocusClock(session);

  return (
    <button type="button" className="focus-pill" onClick={onOpen} title="Open Focus">
      <span className="focus-dot" data-tone={session.isRunning ? 'running' : undefined} />
      <span className="focus-pill-clock">{view.clock}</span>
      <span className="focus-pill-task">{session.isRunning ? session.session.task : `Paused · ${session.session.task}`}</span>
    </button>
  );
}
