import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';
import type { CoachController } from './CoachPanel';
import type { InsightCorrectionController } from './InsightCard';
import { ReflectionContent } from './ReflectionContent';
import {
  PERIOD_TABS,
  anchorForOffset,
  generateResultNotice,
  navigationState,
  resolveTimelineTarget,
  type TimelineTarget,
} from './reflectionView';

/** While a reflection is being written, ask again this often. */
const GENERATING_POLL_MS = 4_000;
/** Live "so far" numbers of a running period are refreshed this often. */
const LIVE_REFRESH_MS = 60_000;

export interface ReflectionPageProps {
  /** Open the Timeline at the evidence behind an insight. */
  onViewTimeline: (target: TimelineTarget) => void;
  /** Run a coach recommendation as a Focus session. */
  onStartFocus: (action: CoachActionDto) => void;
  /** Open on this day's report (an instant inside it); `nonce` makes repeats distinct. */
  target?: { anchor: string | null; nonce: number } | null;
}

/**
 * Reflection — the meaning layer, and the home of the Coach. One period at a
 * time (Today / Week / Month / Year, with history), read as a short briefing
 * rather than a dashboard. A day also carries what is worth doing next, what
 * was already committed to, and a place to talk it over.
 *
 * This component only fetches and forwards: the main process owns the
 * reflection, the actions and the conversation, decides what is allowed, and
 * is the only place Gemini is ever called. Opening the tab never triggers a
 * generation.
 */
export function ReflectionPage({ onViewTimeline, onStartFocus, target }: ReflectionPageProps) {
  const [type, setType] = useState<ReflectionPeriodTypeDto>('day');
  /** `null` = the current period; otherwise an instant inside the period being browsed. */
  const [anchor, setAnchor] = useState<string | null>(null);
  /** The day the tab opened on: the latest one with a reflection (null = today). */
  const [landing, setLanding] = useState<{ resolved: boolean; anchor: string | null }>({ resolved: false, anchor: null });
  const [view, setView] = useState<ReflectionViewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Guards against a slow response for a period the user already left. */
  const requestRef = useRef(0);
  /** A specific day was asked for from outside; the default landing must not override it. */
  const targetedRef = useRef(false);

  // An evidence link is followed to where its raw events are on the Timeline
  // NOW — the block that held them when the reflection was written may have
  // been regrouped, re-analysed or edited since.
  const viewTimeline = useCallback(
    (target: TimelineTarget) => {
      const api = window.reflection;
      if (!target.evidence || !api?.resolveEvidence) return onViewTimeline(target);
      void resolveTimelineTarget(target, (evidence) => api.resolveEvidence(evidence)).then(onViewTimeline);
    },
    [onViewTimeline],
  );

  // "Not accurate": what the disputed insight rests on, as it is linked now.
  const [basis, setBasis] = useState<Record<string, ReflectionInsightBasisDto[]>>({});
  const [unlinked, setUnlinked] = useState<ReadonlySet<string>>(new Set());
  const [correctionBusy, setCorrectionBusy] = useState<string | null>(null);
  const disputedReportId = view?.report?.id ?? null;
  const disputedIds = (view?.report?.insights ?? []).filter((i) => i.feedback === 'inaccurate').map((i) => i.id).join(',');
  useEffect(() => {
    const api = window.reflection;
    if (!disputedReportId || !disputedIds || !api?.getInsightBasis) return;
    let alive = true;
    for (const insightId of disputedIds.split(',')) {
      void api
        .getInsightBasis(disputedReportId, insightId)
        .then((rows) => alive && setBasis((known) => ({ ...known, [insightId]: rows })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [disputedReportId, disputedIds]);
  const correction = useMemo<InsightCorrectionController>(
    () => ({
      basisOf: (insightId) => basis[insightId],
      unlinked,
      busyKey: correctionBusy,
      onUnlink: (insight, row) => {
        const evidence = insight.evidence[row.evidenceIndex];
        const key = `${insight.id}:${row.evidenceIndex}`;
        if (!evidence) return;
        setCorrectionBusy(key);
        void window.reflection
          .correctLink({ evidence: { eventIds: evidence.eventIds, activityId: evidence.activityId, period: evidence.period }, priorityId: null })
          .then((result) => {
            if (result.ok) setUnlinked((set) => new Set([...set, key]));
          })
          .finally(() => setCorrectionBusy(null));
      },
    }),
    [basis, unlinked, correctionBusy],
  );

  const [coachState, setCoachState] = useState<CoachStateDto | null>(null);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const [coachNotice, setCoachNotice] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const coachRequestRef = useRef(0);

  // A morning opens on yesterday's briefing: the latest completed daily
  // report is the landing content, with a way back to today.
  useEffect(() => {
    let cancelled = false;
    window.reflection
      .getLanding()
      .then((result) => {
        if (cancelled) return;
        setLanding({ resolved: true, anchor: result.anchor });
        // A notification that asked for a specific day wins over the default landing.
        if (result.anchor && !targetedRef.current) setAnchor(result.anchor);
      })
      .catch(() => {
        if (!cancelled) setLanding({ resolved: true, anchor: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Opened from the "reflection is ready" notification (or the tray / widget):
  // show that day's report.
  useEffect(() => {
    if (!target?.anchor) return;
    targetedRef.current = true;
    setType('day');
    setAnchor(target.anchor);
  }, [target?.anchor, target?.nonce]);

  const load = useCallback(
    async (showLoading: boolean) => {
      const request = ++requestRef.current;
      if (showLoading) {
        setLoading(true);
        setView(null);
      }
      try {
        const next = await window.reflection.getReport({ type, anchor });
        if (request !== requestRef.current) return;
        setView(next);
        setError(null);
      } catch (e) {
        if (request !== requestRef.current) return;
        console.error('[ReflectionPage] failed to load reflection', e);
        setError((e as Error)?.message ?? String(e));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [type, anchor],
  );

  useEffect(() => {
    if (!landing.resolved) return;
    setNotice(null);
    void load(true);
  }, [load, landing.resolved]);

  // A scheduled reflection landed, or priorities changed, in the main process.
  useEffect(() => {
    const onChanged = () => void load(false);
    window.reflection.onChanged(onChanged);
    return () => window.reflection.offChanged(onChanged);
  }, [load]);

  const generating = view?.generation.state === 'generating';
  const isCurrent = view?.period.isCurrent ?? false;
  useEffect(() => {
    if (!generating && !isCurrent) return;
    const interval = setInterval(() => void load(false), generating ? GENERATING_POLL_MS : LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [generating, isCurrent, load]);

  // ── Coach ──────────────────────────────────────────────────────────────────

  const reportId = type === 'day' ? view?.report?.id ?? null : null;
  const loadCoach = useCallback(async () => {
    const request = ++coachRequestRef.current;
    try {
      const next = await window.coach.getState(reportId);
      if (request === coachRequestRef.current) setCoachState(next);
    } catch (e) {
      console.error('[ReflectionPage] failed to load coach state', e);
    }
  }, [reportId]);

  useEffect(() => {
    if (type !== 'day') return;
    void loadCoach();
  }, [type, loadCoach]);

  // An action was observed, decided or settled in the main process.
  useEffect(() => {
    const onChanged = () => void loadCoach();
    window.coach.onChanged(onChanged);
    return () => window.coach.offChanged(onChanged);
  }, [loadCoach]);

  /** Run one change to an action; the main process is the source of truth for the result. */
  const actOn = useCallback(
    async (actionId: string, run: () => Promise<CoachActionResultDto>) => {
      setBusyActionId(actionId);
      setCoachNotice(null);
      try {
        const result = await run();
        if (!result.ok) setCoachNotice(result.error);
        else if (result.noteDropped) setCoachNotice('Saved. Reflect does not keep health or personal details, so only the reason was stored.');
      } catch (e) {
        console.error('[ReflectionPage] coach action failed', e);
        setCoachNotice('That change could not be saved.');
      } finally {
        setBusyActionId(null);
        void loadCoach();
      }
    },
    [loadCoach],
  );

  const send = useCallback(
    async (text: string) => {
      if (chatBusy) return;
      setChatBusy(true);
      setChatError(null);
      try {
        const result = await window.coach.chat(text);
        if (!result.ok) setChatError(result.message);
      } catch (e) {
        console.error('[ReflectionPage] coach chat failed', e);
        setChatError('Something went wrong while answering. Nothing was changed.');
      } finally {
        setChatBusy(false);
        void loadCoach();
      }
    },
    [chatBusy, loadCoach],
  );

  // The day on screen is "live" when it is the one the tab opens on: today,
  // or the latest day that has a reflection.
  const live = type === 'day' && (anchor === null || anchor === landing.anchor);
  const coach: CoachController | null = useMemo(
    () =>
      type !== 'day'
        ? null
        : {
            state: coachState,
            live,
            busyActionId,
            chatBusy,
            chatError,
            notice: coachNotice,
            onDecide: (id, decision, reason) => void actOn(id, () => window.coach.decide(id, decision, reason)),
            onEdit: (id, patch) => void actOn(id, () => window.coach.edit(id, patch)),
            onExecution: (id, execution, reason) => void actOn(id, () => window.coach.reportExecution(id, execution, reason)),
            onOutcome: (id, outcome, reason) => void actOn(id, () => window.coach.reportOutcome(id, outcome, reason)),
            onStartFocus,
            onSend: (text) => void send(text),
            onRemoveMemory: (id) => {
              void window.coach
                .removeMemory(id)
                .catch((e) => console.error('[ReflectionPage] could not remove memory', e))
                .finally(() => void loadCoach());
            },
            onSaveSettings: (settings) => {
              void window.coach
                .saveSettings(settings)
                .catch((e) => console.error('[ReflectionPage] could not save settings', e))
                .finally(() => {
                  void loadCoach();
                  void load(false);
                });
            },
          },
    [type, coachState, live, busyActionId, chatBusy, chatError, coachNotice, actOn, onStartFocus, send, loadCoach, load],
  );

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await window.reflection.generate({ type, anchor });
      setNotice(generateResultNotice(result));
    } catch (e) {
      console.error('[ReflectionPage] refresh failed', e);
      setNotice('Something went wrong while writing this reflection.');
    } finally {
      setBusy(false);
      void load(false);
      void loadCoach();
    }
  };

  const submitFeedback = async (insightId: string, feedback: ReflectionFeedbackDto | null) => {
    // Reflect the choice immediately; the main process remains the source of truth.
    setView((current) =>
      current?.report
        ? {
            ...current,
            report: {
              ...current.report,
              insights: current.report.insights.map((i) => (i.id === insightId ? { ...i, feedback } : i)),
            },
          }
        : current,
    );
    try {
      await window.reflection.submitFeedback(insightId, feedback);
    } catch (e) {
      console.error('[ReflectionPage] feedback failed', e);
      void load(false);
    }
  };

  const setPriorityStatus = async (id: string, status: ReflectionPriorityDto['status']) => {
    try {
      await window.reflection.setPriorityStatus(id, status);
    } catch (e) {
      console.error('[ReflectionPage] priority update failed', e);
    }
    void load(false);
  };

  const nav = navigationState(view);
  const step = (offset: number) => {
    if (!view) return;
    setAnchor(anchorForOffset(view.period, offset));
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-default shrink-0 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Lightbulb size={20} style={{ color: 'var(--accent)' }} />
          <h1 className="text-[20px] font-extrabold tracking-tight">Reflection</h1>
        </div>
        <div className="flex items-center p-0.5 rounded-lg border border-default" role="tablist" aria-label="Reflection period">
          {PERIOD_TABS.map((tab) => (
            <button
              key={tab.type}
              role="tab"
              aria-selected={type === tab.type}
              onClick={() => {
                // A tab always opens its current period: Today, this week, this month, this year.
                setAnchor(null);
                setType(tab.type);
              }}
              className="px-3 py-1 rounded-md text-[12px] font-bold transition-colors"
              style={{
                background: type === tab.type ? 'var(--bg-secondary)' : 'transparent',
                color: type === tab.type ? 'var(--text)' : 'var(--text-muted)',
                boxShadow: type === tab.type ? 'var(--shadow-sm)' : 'none',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="reflection-page">
          {/* Which period am I looking at? */}
          <div className="flex items-center justify-between gap-4 mb-8">
            <div className="flex items-center gap-2 min-w-0">
              <button
                type="button"
                className="btn btn-ghost px-1.5"
                aria-label="Previous period"
                disabled={!nav.canGoPrevious}
                onClick={() => step(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <div className="min-w-0">
                <div className="text-[20px] font-bold tracking-tight text-default leading-tight">
                  {view?.period.title ?? ' '}
                </div>
                {view && view.period.title !== view.period.range && (
                  <div className="text-[13px] text-muted">{view.period.range}</div>
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost px-1.5"
                aria-label="Next period"
                disabled={!nav.canGoNext}
                onClick={() => step(1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            {view && !nav.isCurrent && (
              <button type="button" className="btn btn-ghost text-[12.5px]" onClick={() => setAnchor(null)}>
                Back to {type === 'day' ? 'today' : `this ${type}`}
              </button>
            )}
          </div>

          <ReflectionContent
            view={view}
            loading={loading}
            error={error}
            busy={busy}
            notice={notice}
            onRefresh={refresh}
            onRetryLoad={() => void load(true)}
            onFeedback={submitFeedback}
            onViewTimeline={viewTimeline}
            correction={correction}
            onSetPriorityStatus={setPriorityStatus}
            coach={coach}
          />
        </div>
      </div>
    </div>
  );
}
