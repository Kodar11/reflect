import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { FocusBusy, UseFocusResult } from './useFocus';
import { PAUSE_REASONS, blockingView, stateLabel } from './focusView';
import { FocusTimer } from './FocusTimer';
import { EndFocusDialog } from './EndFocusDialog';

export interface FocusActiveViewProps {
  session: ActiveFocusSessionDto;
  busy: FocusBusy | null;
  error: string | null;
  pausePickerOpen: boolean;
  /** The reason picked so far in the pause prompt, if any. */
  pauseReason: string | null;
  onOpenPausePicker: () => void;
  onClosePausePicker: () => void;
  onPauseReasonChange: (reason: string | null) => void;
  onPause: (reason: string | null) => void;
  onResume: () => void;
  onEnd: () => void;
  onRestoreBlocking: () => void;
}

/**
 * The active Focus screen: task, timer, state, blocking — and the two
 * actions needed to continue or deliberately exit. Nothing else.
 */
export function FocusActiveView({
  session,
  busy,
  error,
  pausePickerOpen,
  pauseReason,
  onOpenPausePicker,
  onClosePausePicker,
  onPauseReasonChange,
  onPause,
  onResume,
  onEnd,
  onRestoreBlocking,
}: FocusActiveViewProps) {
  const running = session.isRunning;
  const blocking = blockingView(session.blocking);
  const disabled = busy !== null;

  return (
    <div className="focus-stage">
      <div className="focus-column" data-align="center">
        <div className="focus-eyebrow" data-tone={running ? 'running' : undefined}>
          <span className="focus-dot" data-tone={running ? 'running' : undefined} />
          {stateLabel(session)}
        </div>

        <div className="focus-task" title={session.session.task}>
          {session.session.task}
        </div>

        <FocusTimer session={session} />

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
          <div className="focus-meta" title={session.profile.name}>
            {session.profile.name}
          </div>
          <div className="focus-status">
            <span className="focus-dot" data-tone={blocking.tone === 'muted' ? undefined : blocking.tone} />
            {blocking.text}
            {blocking.canRestore && (
              <button type="button" className="focus-link" data-tone="accent" onClick={onRestoreBlocking} disabled={disabled}>
                {busy === 'restoring' ? 'Restoring…' : 'Restore'}
              </button>
            )}
          </div>
          {!running && session.blocking.status === 'active' && <div className="focus-hint">Blocking remains active while paused.</div>}
        </div>

        {blocking.detail && blocking.tone === 'warn' && (
          <div className="focus-note" data-tone="warn">{blocking.detail}</div>
        )}
        {error && <div className="focus-note" data-tone="error">{error}</div>}

        {pausePickerOpen && running ? (
          <div className="focus-panel" role="group" aria-label="Pause Focus">
            <div className="focus-panel-title">Pause Focus?</div>
            <div className="focus-chips" style={{ justifyContent: 'center' }}>
              {PAUSE_REASONS.map((reason) => (
                <button
                  key={reason}
                  type="button"
                  className="focus-chip"
                  aria-pressed={pauseReason === reason}
                  onClick={() => onPauseReasonChange(pauseReason === reason ? null : reason)}
                  disabled={disabled}
                >
                  {reason}
                </button>
              ))}
            </div>
            <div className="focus-actions" style={{ marginTop: 14 }}>
              <button type="button" className="focus-btn" data-variant="primary" autoFocus onClick={onClosePausePicker} disabled={disabled}>
                Keep Focusing
              </button>
              <button type="button" className="focus-btn" onClick={() => onPause(pauseReason)} disabled={disabled}>
                {busy === 'pausing' ? 'Pausing…' : 'Pause'}
              </button>
            </div>
          </div>
        ) : (
          <div className="focus-actions">
            {running ? (
              <button type="button" className="focus-btn" onClick={onOpenPausePicker} disabled={disabled}>
                <Pause size={15} /> Pause
              </button>
            ) : (
              <button type="button" className="focus-btn" data-variant="primary" onClick={onResume} disabled={disabled}>
                <Play size={15} /> {busy === 'resuming' ? 'Resuming…' : 'Resume'}
              </button>
            )}
            <button type="button" className="focus-btn" onClick={onEnd} disabled={disabled}>
              End Focus
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface FocusActiveProps {
  focus: UseFocusResult;
  session: ActiveFocusSessionDto;
}

/** Wires the active view to the service: pause picker, exit flow, shortcuts. */
export function FocusActive({ focus, session }: FocusActiveProps) {
  const { busy, error, intent, consumeIntent, pause, resume, requestEnd, confirmEnd, restoreBlocking } = focus;
  const [pausePickerOpen, setPausePickerOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<EndFocusChallengeDto | null>(null);
  const [endError, setEndError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  // While the exit dialog is open the page behind it takes no input at all —
  // not by mouse and not by tabbing to it.
  useEffect(() => {
    hostRef.current?.toggleAttribute('inert', challenge !== null);
  }, [challenge]);

  const openEnd = useCallback(async () => {
    setPausePickerOpen(false);
    setEndError(null);
    const next = await requestEnd();
    if (next) setChallenge(next);
  }, [requestEnd]);

  // Tray "Pause Focus…" / "End Focus…" land here — the same flows as the
  // buttons, never a shortcut past them.
  useEffect(() => {
    if (!intent) return;
    if (intent.kind === 'pause' && session.isRunning) setPausePickerOpen(true);
    if (intent.kind === 'end') void openEnd();
    consumeIntent();
  }, [intent, consumeIntent, openEnd, session.isRunning]);

  // The prompt only makes sense while running, and starts fresh each time.
  useEffect(() => {
    if (!session.isRunning) setPausePickerOpen(false);
  }, [session.isRunning]);
  useEffect(() => {
    if (!pausePickerOpen) setPauseReason(null);
  }, [pausePickerOpen]);

  // Space: open the pause picker / resume. Escape only ever closes things.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (challenge) return;
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
      if (e.code === 'Space' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (session.isRunning) setPausePickerOpen(true);
        else void resume();
      } else if (e.key === 'Escape') {
        setPausePickerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [challenge, resume, session.isRunning]);

  return (
    <>
      <div ref={hostRef} className="focus-host">
      <FocusActiveView
        session={session}
        busy={busy}
        error={error}
        pausePickerOpen={pausePickerOpen}
        pauseReason={pauseReason}
        onPauseReasonChange={setPauseReason}
        onOpenPausePicker={() => setPausePickerOpen(true)}
        onClosePausePicker={() => setPausePickerOpen(false)}
        onPause={(reason) => {
          // The view switches to "Paused" when the backend confirms it.
          void pause(reason).then((ok) => {
            if (ok) setPausePickerOpen(false);
          });
        }}
        onResume={() => void resume()}
        onEnd={() => void openEnd()}
        onRestoreBlocking={() => void restoreBlocking()}
      />
      </div>
      {challenge && (
        <EndFocusDialog
          challenge={challenge}
          task={session.session.task}
          busy={busy === 'ending'}
          error={endError}
          onKeep={() => {
            setChallenge(null);
            setEndError(null);
          }}
          onConfirm={async (phrase, reason) => {
            const problem = await confirmEnd({ token: challenge.token, phrase, reason });
            if (problem) setEndError(problem);
            else setChallenge(null);
          }}
        />
      )}
    </>
  );
}
