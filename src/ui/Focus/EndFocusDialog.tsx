import { useEffect, useRef, useState, type RefObject } from 'react';
import { END_REASONS, endDialogCopy, phraseMatches } from './focusView';
import { useDialog } from './useDialog';

export interface EndFocusDialogViewProps {
  challenge: EndFocusChallengeDto;
  task: string;
  step: 'confirm' | 'type';
  typed: string;
  reason: string | null;
  busy: boolean;
  /** Why the service refused the last confirmation, if it did. */
  error: string | null;
  onKeep: () => void;
  /** Leave the first step: on to the typed phrase, or straight to ending. */
  onContinue: () => void;
  onTypedChange: (typed: string) => void;
  onReasonChange: (reason: string | null) => void;
  onSubmit: () => void;
  keepRef?: RefObject<HTMLButtonElement>;
  inputRef?: RefObject<HTMLInputElement>;
  dialogRef?: RefObject<HTMLDivElement>;
}

/**
 * The deliberate exit. Two steps for an early end — a confirmation, then a
 * typed phrase — so it takes a decision rather than a stray click. The
 * dialog is only the interface: the service issued `challenge` and checks
 * the answer itself.
 *
 * "Keep Focusing" is always the primary action.
 */
export function EndFocusDialogView({
  challenge, task, step, typed, reason, busy, error, onKeep, onContinue, onTypedChange, onReasonChange, onSubmit, keepRef, inputRef, dialogRef,
}: EndFocusDialogViewProps) {
  const copy = endDialogCopy(challenge);
  const canEnd = phraseMatches(typed, challenge) && !busy;

  return (
    <div
      className="focus-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onKeep();
      }}
    >
      <div ref={dialogRef} className="focus-dialog" role="dialog" aria-modal="true" aria-labelledby="end-focus-title">
        <div>
          <div id="end-focus-title" className="focus-dialog-title">
            {step === 'confirm' ? copy.title : 'End this Focus session?'}
          </div>
          <div className="focus-meta" style={{ marginTop: 4 }} title={task}>
            {task}
          </div>
        </div>

        {step === 'confirm' ? (
          <>
            <div className="focus-dialog-body">
              {copy.body.map((line, i) => (
                <p key={line} style={{ marginTop: i === 0 ? 0 : 4 }}>
                  {i === 0 && challenge.early ? <strong>{line}</strong> : line}
                </p>
              ))}
            </div>
            {error && <div className="focus-note" data-tone="error">{error}</div>}
            <div className="focus-actions">
              <button ref={keepRef} type="button" className="focus-btn" data-variant="primary" onClick={onKeep} disabled={busy}>
                Keep Focusing
              </button>
              <button type="button" className="focus-btn" disabled={busy} onClick={onContinue}>
                {busy ? 'Ending…' : copy.confirmLabel}
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canEnd) onSubmit();
            }}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div>
              <label className="focus-label" htmlFor="end-focus-phrase">
                Type {challenge.phrase} to confirm
              </label>
              <input
                id="end-focus-phrase"
                ref={inputRef}
                className="focus-input"
                value={typed}
                onChange={(e) => onTypedChange(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={20}
                disabled={busy}
              />
            </div>
            <div>
              <div className="focus-label">Reason (optional)</div>
              <div className="focus-chips">
                {END_REASONS.map((r) => (
                  <button
                    key={r}
                    type="button"
                    className="focus-chip"
                    aria-pressed={reason === r}
                    onClick={() => onReasonChange(reason === r ? null : r)}
                    disabled={busy}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            {error && <div className="focus-note" data-tone="error">{error}</div>}
            <div className="focus-actions">
              <button type="button" className="focus-btn" data-variant="primary" onClick={onKeep} disabled={busy}>
                Keep Focusing
              </button>
              <button type="submit" className="focus-btn" data-variant="danger" disabled={!canEnd}>
                {busy ? 'Ending…' : 'End Focus'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

interface EndFocusDialogProps {
  challenge: EndFocusChallengeDto;
  task: string;
  busy: boolean;
  error: string | null;
  onKeep: () => void;
  onConfirm: (phrase: string | null, reason: string | null) => void;
}

/** Holds the dialog's local state. Escape and clicking outside keep the session. */
export function EndFocusDialog({ challenge, task, busy, error, onKeep, onConfirm }: EndFocusDialogProps) {
  const [step, setStep] = useState<'confirm' | 'type'>('confirm');
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'type') inputRef.current?.focus();
    else keepRef.current?.focus();
  }, [step]);

  // Escape keeps the session; it can never confirm the end.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialog(dialogRef, () => {
    if (!busy) onKeep();
  });

  return (
    <EndFocusDialogView
      challenge={challenge}
      task={task}
      step={step}
      typed={typed}
      reason={reason}
      busy={busy}
      error={error}
      onKeep={onKeep}
      onContinue={() => (challenge.requiresPhrase ? setStep('type') : onConfirm(null, null))}
      onTypedChange={setTyped}
      onReasonChange={setReason}
      onSubmit={() => onConfirm(typed, reason)}
      keepRef={keepRef}
      inputRef={inputRef}
      dialogRef={dialogRef}
    />
  );
}
