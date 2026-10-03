import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, X } from 'lucide-react';

/** How often the main process is asked whether there is something to suggest.
 * The main process owns eligibility and cooldowns; this is only a poll. */
const POLL_INTERVAL_MS = 60_000;
const FIRST_POLL_DELAY_MS = 15_000;

interface LearnedPatternToastProps {
  /** Called after a pattern became a learned rule, so open views can refresh. */
  onRemembered?: () => void;
}

/**
 * Lightweight surface for a learned-pattern suggestion. Renders whatever the
 * main process hands over and reports the answer back — it never decides
 * eligibility itself.
 */
export function LearnedPatternToast({ onRemembered }: LearnedPatternToastProps) {
  const [suggestion, setSuggestion] = useState<LearnedRuleSuggestionDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const showing = useRef(false);

  useEffect(() => {
    showing.current = suggestion !== null;
  }, [suggestion]);

  const poll = useCallback(async () => {
    // One suggestion at a time: never replace one the user has not answered.
    if (showing.current) return;
    try {
      const next = await window.learnedRules.nextSuggestion();
      if (next && !showing.current) setSuggestion(next);
    } catch (e) {
      console.error('[LearnedPatternToast] failed to load suggestion', e);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(poll, FIRST_POLL_DELAY_MS);
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [poll]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const answer = async (action: 'remember' | 'not_now' | 'never') => {
    if (!suggestion || busy) return;
    setBusy(true);
    try {
      if (action === 'remember') {
        await window.learnedRules.confirmCandidate(suggestion.candidateId);
        setNotice('Remembered. This pattern is now a learned rule.');
        onRemembered?.();
      } else if (action === 'not_now') {
        await window.learnedRules.snoozeCandidate(suggestion.candidateId);
      } else {
        await window.learnedRules.dismissCandidate(suggestion.candidateId);
      }
      setSuggestion(null);
    } catch (e) {
      console.error('[LearnedPatternToast] action failed', e);
      setNotice((e as Error)?.message ?? 'Could not save your choice.');
      setSuggestion(null);
    } finally {
      setBusy(false);
    }
  };

  if (!suggestion && !notice) return null;

  return (
    <div
      className="card"
      role="status"
      style={{
        position: 'fixed',
        bottom: 20,
        left: 20,
        zIndex: 900,
        width: 340,
        padding: 14,
        borderRadius: 12,
        boxShadow: 'var(--shadow-lg)',
        animation: 'fadeIn 180ms var(--ease-out)',
      }}
    >
      {suggestion ? (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-1.5 text-[13px] font-bold text-default">
              <Sparkles size={14} style={{ color: 'var(--accent)' }} />
              {suggestion.trigger === 'daily' ? 'Reflect noticed a recurring pattern' : 'Remember this pattern?'}
            </div>
            <button
              type="button"
              title="Not now"
              aria-label="Not now"
              disabled={busy}
              onClick={() => answer('not_now')}
              style={{ color: 'var(--text-muted)', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}
            >
              <X size={14} />
            </button>
          </div>

          <div>
            <div className="text-[13px] font-semibold text-default break-words">{suggestion.patternLabel}</div>
            {suggestion.classificationLabel && (
              <div className="text-[12px] text-muted mt-0.5">{suggestion.classificationLabel}</div>
            )}
            <div className="text-[11.5px] text-faint mt-1">{suggestion.evidenceLabel}</div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={() => answer('never')}
              className="text-[11px] text-faint"
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              Never suggest this
            </button>
            <div className="flex gap-2">
              <button className="btn btn-secondary py-1 px-3 text-[11.5px]" disabled={busy} onClick={() => answer('not_now')}>
                Not now
              </button>
              <button className="btn btn-primary py-1 px-3 text-[11.5px] font-bold" disabled={busy} onClick={() => answer('remember')}>
                Remember
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="text-[12.5px] text-muted">{notice}</div>
      )}
    </div>
  );
}
