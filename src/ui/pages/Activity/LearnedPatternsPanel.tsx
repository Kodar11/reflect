import { useCallback, useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';

interface LearnedPatternsPanelProps {
  /** Called after a pattern became a rule, so the rules table reloads. */
  onRulesChanged: () => Promise<void> | void;
}

/**
 * Patterns Reflect would like to remember, shown above the rules table. They
 * are not rules yet: the list comes from the main process, which alone decides
 * what is eligible. Renders nothing when there is nothing to show.
 */
export function LearnedPatternsPanel({ onRulesChanged }: LearnedPatternsPanelProps) {
  const [suggestions, setSuggestions] = useState<LearnedRuleSuggestionDto[]>([]);
  const [ignored, setIgnored] = useState<LearnedRuleCandidateDto[]>([]);
  const [showIgnored, setShowIgnored] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [eligible, candidates] = await Promise.all([
        window.learnedRules.listSuggestions(),
        window.learnedRules.listCandidates(),
      ]);
      setSuggestions(eligible);
      setIgnored(candidates.filter((c) => c.status === 'dismissed'));
    } catch (e) {
      console.error('[LearnedPatternsPanel] failed to load', e);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const run = async (candidateId: string, action: () => Promise<unknown>, refreshRules = false) => {
    setBusyId(candidateId);
    setError(null);
    try {
      await action();
      if (refreshRules) await onRulesChanged();
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not save your choice.');
    } finally {
      setBusyId(null);
      await load();
    }
  };

  if (suggestions.length === 0 && ignored.length === 0) return null;

  return (
    <div className="card rounded-xl border border-default mb-4">
      <div className="card-section py-3 px-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[12.5px] font-bold text-default">
            <Sparkles size={13} style={{ color: 'var(--accent)' }} />
            Suggested patterns
            <span className="text-faint font-semibold">· not rules until you remember them</span>
          </div>
          {ignored.length > 0 && (
            <button
              type="button"
              className="text-[11px] text-muted"
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
              onClick={() => setShowIgnored((v) => !v)}
            >
              {showIgnored ? 'Hide' : 'Show'} ignored ({ignored.length})
            </button>
          )}
        </div>

        {error && <div className="text-[12px] text-danger">{error}</div>}

        {suggestions.length === 0 && !showIgnored && (
          <div className="text-[12px] text-faint">No patterns to suggest right now.</div>
        )}

        {suggestions.map((s) => (
          <div key={s.candidateId} className="flex items-center justify-between gap-3 py-1.5 border-t border-default">
            <div className="min-w-0">
              <div className="text-[12.5px] font-semibold text-default break-words">
                {s.patternLabel}
                {s.classificationLabel && <span className="text-muted font-normal"> → {s.classificationLabel}</span>}
              </div>
              <div className="text-[11.5px] text-faint">
                {s.evidenceLabel}
                {s.correctionCount > 0 &&
                  ` · corrected by you ${s.correctionCount === 1 ? 'once' : `${s.correctionCount} times`}`}
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="text-[11px] text-faint"
                style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                disabled={busyId === s.candidateId}
                onClick={() => run(s.candidateId, () => window.learnedRules.dismissCandidate(s.candidateId))}
              >
                Never
              </button>
              <button
                className="btn btn-secondary py-1 px-3 text-[11.5px]"
                disabled={busyId === s.candidateId}
                onClick={() => run(s.candidateId, () => window.learnedRules.snoozeCandidate(s.candidateId))}
              >
                Not now
              </button>
              <button
                className="btn btn-primary py-1 px-3 text-[11.5px] font-bold"
                disabled={busyId === s.candidateId}
                onClick={() => run(s.candidateId, () => window.learnedRules.confirmCandidate(s.candidateId), true)}
              >
                Remember
              </button>
            </div>
          </div>
        ))}

        {showIgnored &&
          ignored.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 py-1.5 border-t border-default">
              <div className="min-w-0 text-[12.5px] text-muted break-words">
                {c.patternLabel}
                {c.classificationLabel && ` → ${c.classificationLabel}`}
                <span className="text-faint"> · ignored</span>
              </div>
              <button
                className="btn btn-secondary py-1 px-3 text-[11.5px] shrink-0"
                disabled={busyId === c.id}
                onClick={() => run(c.id, () => window.learnedRules.reactivateCandidate(c.id))}
              >
                Restore
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
