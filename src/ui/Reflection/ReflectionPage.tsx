import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Lightbulb } from 'lucide-react';
import { ReflectionContent } from './ReflectionContent';
import {
  PERIOD_TABS,
  anchorForOffset,
  generateResultNotice,
  navigationState,
  type TimelineTarget,
} from './reflectionView';

/** While a reflection is being written, ask again this often. */
const GENERATING_POLL_MS = 4_000;
/** Live "so far" numbers of a running period are refreshed this often. */
const LIVE_REFRESH_MS = 60_000;

export interface ReflectionPageProps {
  /** Open the Timeline at the evidence behind an insight. */
  onViewTimeline: (target: TimelineTarget) => void;
}

/**
 * Reflection — the meaning layer. One period at a time (Today / Week / Month
 * / Year, with history), read as a short briefing rather than a dashboard.
 *
 * This component only fetches and forwards: the main process owns the
 * reflection, decides whether a refresh is allowed, and is the only place
 * Gemini is ever called. Opening the tab never triggers a generation.
 */
export function ReflectionPage({ onViewTimeline }: ReflectionPageProps) {
  const [type, setType] = useState<ReflectionPeriodTypeDto>('day');
  /** `null` = the current period; otherwise an instant inside the period being browsed. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [view, setView] = useState<ReflectionViewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Guards against a slow response for a period the user already left. */
  const requestRef = useRef(0);

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
    setNotice(null);
    void load(true);
  }, [load]);

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
                  {view?.period.title ?? ' '}
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
            onViewTimeline={onViewTimeline}
            onSetPriorityStatus={setPriorityStatus}
          />
        </div>
      </div>
    </div>
  );
}
