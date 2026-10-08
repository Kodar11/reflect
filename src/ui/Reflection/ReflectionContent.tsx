import { Loader2, RefreshCw } from 'lucide-react';
import {
  CoachActionCard,
  CoachActionRow,
  CoachCommitments,
  CoachConversation,
  CoachKnowledge,
  CoachRecent,
  CoachSettings,
  type CoachController,
} from './CoachPanel';
import { groupInsights, nextActions } from './coachView';
import { EvidenceList, InsightCard, type InsightCorrectionController } from './InsightCard';
import {
  dailyReflectionTimeLabel,
  deriveScreen,
  formatGeneratedAt,
  refreshHint,
  refreshLabel,
  shortMetricLabel,
  staleMessage,
  staleNote,
  carryStatusLine,
  timelineTargetFor,
  type TimelineTarget,
} from './reflectionView';

export interface ReflectionContentProps {
  view: ReflectionViewDto | null;
  loading: boolean;
  error: string | null;
  /** A refresh requested from this page is in flight. */
  busy: boolean;
  notice: string | null;
  onRefresh: () => void;
  onRetryLoad: () => void;
  onFeedback: (insightId: string, feedback: ReflectionFeedbackDto | null) => void;
  onViewTimeline: (target: TimelineTarget) => void;
  onSetPriorityStatus: (id: string, status: ReflectionPriorityDto['status']) => void;
  /** The Coach. Present on the day view; a day is then read as a briefing. */
  coach?: CoachController | null;
  /** Correcting what a disputed insight rests on. */
  correction?: InsightCorrectionController | null;
}

/**
 * The body of the Reflection page for one period. Purely presentational: it
 * renders whatever the main process handed over.
 *
 * Reading order is the product: period → headline → a few insights with their
 * evidence → one carry-forward → small supporting numbers.
 *
 * A day, with the Coach, is a personal briefing instead: what happened → what
 * stands out → what changed → what it means for your priorities → what is
 * worth doing next → what you already committed to → a place to talk it over.
 */
export function ReflectionContent(props: ReflectionContentProps) {
  const { view, error, busy, notice, onRefresh, onRetryLoad } = props;
  const screen = deriveScreen(props);

  if (screen === 'loading') {
    return (
      <div className="reflection-state" role="status">
        <Loader2 size={16} className="animate-spin" />
        Loading reflection…
      </div>
    );
  }
  if (screen === 'error' || !view) {
    return (
      <div className="reflection-state" role="alert">
        <span>Could not load this reflection{error ? `: ${error}` : '.'}</span>
        <button type="button" className="btn btn-ghost" onClick={onRetryLoad}>
          Try again
        </button>
      </div>
    );
  }

  const generating = busy || view.generation.state === 'generating';
  const coach = view.period.type === 'day' ? props.coach ?? null : null;
  const hint = refreshHint(view);
  const refreshButton = (primary: boolean) => (
    <button
      type="button"
      className={primary ? 'btn btn-primary' : 'btn btn-ghost'}
      disabled={!view.canRefresh || generating}
      title={hint ?? undefined}
      onClick={onRefresh}
    >
      {generating ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
      {generating ? 'Writing…' : refreshLabel(view)}
    </button>
  );

  return (
    <div className="space-y-8" style={{ animation: 'fadeIn 180ms var(--ease-out)' }}>
      {notice && (
        <div className="reflection-banner" role="status">
          {notice}
        </div>
      )}

      {/* A period still running: what the day / week looks like so far. */}
      {view.live && view.live.metrics.length > 0 && view.period.isCurrent && (
        <LiveNumbers title={`${view.period.title} so far`} metrics={view.live.metrics} />
      )}

      {coach?.notice && (
        <div className="reflection-banner" role="status">
          {coach.notice}
        </div>
      )}

      {screen === 'report' && view.report ? (
        coach ? (
          <DailyBody {...props} view={view} report={view.report} coach={coach} refreshButton={refreshButton(false)} generating={generating} />
        ) : (
          <ReportBody {...props} view={view} report={view.report} refreshButton={refreshButton(false)} generating={generating} />
        )
      ) : (
        <EmptyState screen={screen} view={view} refreshButton={refreshButton(true)} hint={hint} />
      )}

      {coach && (
        <CoachLive coach={coach} view={view} onViewTimeline={props.onViewTimeline} showNext={!(screen === 'report' && view.report)} />
      )}

      {coach && screen === 'report' && view.report && <DailyNumbers view={view} report={view.report} onViewTimeline={props.onViewTimeline} />}

      <Priorities priorities={view.priorities} onSetStatus={props.onSetPriorityStatus} />
    </div>
  );
}

function ReportBody({
  view,
  report,
  refreshButton,
  generating,
  onFeedback,
  onViewTimeline,
  correction,
}: ReflectionContentProps & { view: ReflectionViewDto; report: ReflectionReportDto; refreshButton: JSX.Element; generating: boolean }) {
  const generatedAt = formatGeneratedAt(report.generatedAt);
  const failed = view.generation.state === 'failed';
  return (
    <>
      {report.status === 'stale' && (
        <div className="reflection-banner" role="status">
          <span>{staleMessage(report.staleReason)} {staleNote(report.staleReason)}</span>
        </div>
      )}
      {failed && view.generation.message && (
        <div className="reflection-banner" role="status">
          The last refresh did not complete. {view.generation.message} The reflection below is the previous one.
        </div>
      )}

      {report.outdated && report.status !== 'stale' && (
        <div className="reflection-banner" role="status">
          This reflection was written by an earlier version of Reflect. You can refresh it to have it rewritten.
        </div>
      )}

      <section>
        <p className="reflection-headline text-default">{report.headline}</p>
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="text-[12.5px] text-faint">
            {generatedAt ? `Written ${generatedAt}` : 'Written earlier'}
            {report.isPartial && view.period.isCurrent ? ' · covers this period so far' : ''}
          </div>
          {(view.canRefresh || generating || report.status === 'stale') && refreshButton}
        </div>
      </section>

      {report.insights.length > 0 && (
        <section className="space-y-7">
          {report.insights.map((insight) => (
            <InsightCard
              key={insight.id}
              insight={insight}
              period={view.period}
              correction={correction}
              onFeedback={onFeedback}
              onViewTimeline={onViewTimeline}
            />
          ))}
        </section>
      )}

      {report.carryForward && (
        <section className="reflection-carry">
          <div className="reflection-eyebrow">Carry forward</div>
          <p className="reflection-prose text-default mt-1.5 font-medium">{report.carryForward.text}</p>
          <div className="mt-2">
            <EvidenceList evidence={report.carryForward.evidence} period={view.period} onViewTimeline={onViewTimeline} />
          </div>
        </section>
      )}

      <CarriedWork report={report} onViewTimeline={onViewTimeline} />

      {report.supportingMetrics.length > 0 && (
        <section>
          <div className="flex items-center justify-between">
            <div className="reflection-eyebrow">Supporting numbers</div>
            <button type="button" className="reflection-link" onClick={() => onViewTimeline(timelineTargetFor(null, view.period))}>
              View this period in the timeline
            </button>
          </div>
          <MetricRow metrics={report.supportingMetrics} />
        </section>
      )}

      {report.notes.length > 0 && (
        <ul className="text-[12.5px] text-faint space-y-1">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * What persisted across periods: work that is still unresolved, work that was
 * picked up again, and what the user closed. Each row leads to the last time
 * it was worked on. Nothing is shown when nothing is carried.
 */
export function CarriedWork({ report, onViewTimeline }: { report: Pick<ReflectionReportDto, 'carried'>; onViewTimeline: (target: TimelineTarget) => void }) {
  const carried = report.carried ?? [];
  if (carried.length === 0) return null;
  return (
    <section className="reflection-carry" data-testid="carried-work">
      <div className="reflection-eyebrow">Across periods</div>
      <ul className="mt-2 space-y-1.5">
        {carried.map((item) => (
          <li key={item.key} className="reflection-evidence-row" data-carry-status={item.status}>
            <span className="min-w-0">
              <span className="text-default font-medium">{item.title}</span>
              <span className="text-muted"> — {carryStatusLine(item)}</span>
            </span>
            {item.lastWorked && (
              <button
                type="button"
                className="reflection-link shrink-0"
                onClick={() => onViewTimeline({ day: item.lastWorked!.start, view: 'day', activityId: null })}
              >
                Last worked
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

type BodyProps = ReflectionContentProps & { view: ReflectionViewDto; report: ReflectionReportDto; refreshButton: JSX.Element; generating: boolean };

/**
 * A day's intelligence, read top to bottom: the reflection and the coaching
 * were written together, so they are shown as one briefing.
 */
function DailyBody({ view, report, coach, refreshButton, generating, onFeedback, onViewTimeline, correction }: BodyProps & { coach: CoachController }) {
  const generatedAt = formatGeneratedAt(report.generatedAt);
  const failed = view.generation.state === 'failed';
  const groups = groupInsights(report.insights);
  const next = nextActions(report, coach.state, coach.live);
  // A section heading that already names the kind of insight replaces the per-insight label.
  const insightList = (insights: ReflectionInsightDto[], hideLabel = false) =>
    insights.map((insight) => (
      <InsightCard
        key={insight.id}
        insight={insight}
        period={view.period}
        correction={correction}
        onFeedback={onFeedback}
        onViewTimeline={onViewTimeline}
        hideLabel={hideLabel}
      />
    ));

  return (
    <>
      {report.status === 'stale' && (
        <div className="reflection-banner" role="status">
          <span>{staleMessage(report.staleReason)} {staleNote(report.staleReason)}</span>
        </div>
      )}
      {failed && view.generation.message && (
        <div className="reflection-banner" role="status">
          The last refresh did not complete. {view.generation.message} The reflection below is the previous one.
        </div>
      )}

      <section>
        <div className="reflection-eyebrow">What happened</div>
        <p className="reflection-headline text-default mt-2">{report.headline}</p>
        {report.narrative && <p className="reflection-prose text-default mt-3">{report.narrative}</p>}
        <div className="mt-3 flex items-center justify-between gap-4">
          <div className="text-[12.5px] text-faint">
            {generatedAt ? `Written ${generatedAt}` : 'Written earlier'}
            {report.isPartial && view.period.isCurrent ? ' · covers today so far' : ''}
          </div>
          {(view.canRefresh || generating || report.status === 'stale') && refreshButton}
        </div>
      </section>

      {groups.standsOut.length > 0 && (
        <section>
          <div className="reflection-eyebrow">What stands out</div>
          <div className="reflection-group space-y-7 mt-3">{insightList(groups.standsOut)}</div>
        </section>
      )}

      {groups.changed.length > 0 && (
        <section>
          <div className="reflection-eyebrow">What changed</div>
          <div className="reflection-group space-y-7 mt-3">{insightList(groups.changed, true)}</div>
        </section>
      )}

      {groups.priorities.length > 0 && (
        <section>
          <div className="reflection-eyebrow">What this means for your priorities</div>
          <div className="reflection-group space-y-7 mt-3">{insightList(groups.priorities, true)}</div>
        </section>
      )}

      {/* What is still open going into tomorrow, and what closed today. */}
      <CarriedWork report={report} onViewTimeline={onViewTimeline} />

      {report.coach && report.coach.followups.length > 0 && (
        <section className="coach-section">
          <div className="reflection-eyebrow">What you had planned</div>
          <ul className="coach-followups">
            {report.coach.followups.map((followup) => (
              <li key={followup.actionId}>
                {followup.title && <div className="text-[14px] font-semibold text-default">{followup.title}</div>}
                <p className="reflection-prose text-default">{followup.note}</p>
                {followup.learned && <p className="reflection-prose text-muted">{followup.learned}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.coach && report.coach.uncertainty.length > 0 && (
        <section>
          <div className="reflection-eyebrow">What Reflect is not sure about</div>
          <ul className="coach-uncertainty">
            {report.coach.uncertainty.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="coach-section" aria-label="Next">
        <div className="reflection-eyebrow">Next</div>
        {next.undecided.length > 0 ? (
          <div className="space-y-5 mt-3">
            {next.undecided.map((action) => (
              <CoachActionCard key={action.id} action={action} coach={coach} period={view.period} onViewTimeline={onViewTimeline} />
            ))}
          </div>
        ) : next.decided.length === 0 ? (
          report.carryForward && !report.coach ? (
            // A reflection written before the Coach existed: its one carry-forward.
            <div className="reflection-carry mt-3">
              <p className="reflection-prose text-default font-medium">{report.carryForward.text}</p>
              <div className="mt-2">
                <EvidenceList evidence={report.carryForward.evidence} period={view.period} onViewTimeline={onViewTimeline} />
              </div>
            </div>
          ) : (
            <p className="reflection-prose text-muted mt-2">
              No suggestion today.{report.coach?.noActionReason ? ` ${report.coach.noActionReason}` : ''}
            </p>
          )
        ) : null}
        {next.decided.length > 0 && (
          <ul className="coach-rows">
            {next.decided.map((action) => (
              <CoachActionRow key={action.id} action={action} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** The day's small, secondary numbers — below everything that asks for a decision. */
function DailyNumbers({
  view,
  report,
  onViewTimeline,
}: {
  view: ReflectionViewDto;
  report: ReflectionReportDto;
  onViewTimeline: (target: TimelineTarget) => void;
}) {
  return (
    <>
      {report.supportingMetrics.length > 0 && (
        <section className="coach-section">
          <div className="flex items-center justify-between">
            <div className="reflection-eyebrow">Supporting numbers</div>
            <button type="button" className="reflection-link" onClick={() => onViewTimeline(timelineTargetFor(null, view.period))}>
              View this day in the timeline
            </button>
          </div>
          <MetricRow metrics={report.supportingMetrics} />
        </section>
      )}

      {report.notes.length > 0 && (
        <ul className="text-[12.5px] text-faint space-y-1">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The parts of the Coach that are about NOW, whichever day is on screen: what
 * the user committed to, what is waiting for their word, and the conversation.
 */
function CoachLive({
  coach,
  view,
  onViewTimeline,
  showNext,
}: {
  coach: CoachController;
  view: ReflectionViewDto;
  onViewTimeline: (target: TimelineTarget) => void;
  /** No report is on screen, so suggestions waiting for a decision are shown here. */
  showNext: boolean;
}) {
  const waiting = showNext ? nextActions(null, coach.state, true).undecided : [];
  return (
    <>
      {waiting.length > 0 && (
        <section className="coach-section" aria-label="Next">
          <div className="reflection-eyebrow">Next</div>
          <div className="space-y-5 mt-3">
            {waiting.map((action) => (
              <CoachActionCard key={action.id} action={action} coach={coach} period={view.period} onViewTimeline={onViewTimeline} />
            ))}
          </div>
        </section>
      )}
      <CoachCommitments coach={coach} period={view.period} onViewTimeline={onViewTimeline} />
      <CoachConversation coach={coach} onViewTimeline={onViewTimeline} />
      <CoachRecent coach={coach} period={view.period} onViewTimeline={onViewTimeline} />
      <CoachKnowledge coach={coach} />
      <CoachSettings coach={coach} />
    </>
  );
}

function EmptyState({
  screen,
  view,
  refreshButton,
  hint,
}: {
  screen: ReturnType<typeof deriveScreen>;
  view: ReflectionViewDto;
  refreshButton: JSX.Element;
  hint: string | null;
}) {
  const closedNumbers = !view.period.isCurrent && view.live && view.live.metrics.length > 0;

  let title: string;
  let detail: string | null = null;
  let action = false;
  switch (screen) {
    case 'generating':
      title = 'Writing this reflection…';
      detail = 'Reflect is reading the period’s activity and checking every claim against it.';
      break;
    case 'insufficient':
      title = view.sufficiency.message ?? 'Not enough activity to reflect on yet.';
      detail = view.period.isCurrent ? 'A reflection will appear once there is more to look at.' : null;
      break;
    case 'failed':
      title = 'This reflection could not be written.';
      detail = view.generation.message;
      action = true;
      break;
    case 'unconfigured':
      title = 'Reflections are written with Gemini.';
      detail = 'Gemini is not configured, so only the measured numbers are available for this period.';
      break;
    default:
      if (view.period.isCurrent && view.period.type === 'day') {
        title = 'Today’s reflection has not been written yet.';
        detail = `Reflect writes it around ${dailyReflectionTimeLabel(view)}, once most of the day has happened.`;
      } else if (view.period.isCurrent) {
        title = `This ${view.period.type} is still in progress.`;
        detail = `Its reflection is written when the ${view.period.type} closes. You can ask for one covering it so far.`;
      } else {
        title = 'No reflection was written for this period.';
      }
      action = true;
  }

  return (
    <section className="reflection-empty" role="status">
      <p className="text-[16px] font-semibold text-default">{title}</p>
      {detail && <p className="text-[13.5px] text-muted mt-1.5">{detail}</p>}
      {closedNumbers && (
        <div className="mt-5">
          <div className="reflection-eyebrow">What Reflect measured</div>
          <MetricRow metrics={view.live!.metrics} />
        </div>
      )}
      {action && (
        <div className="mt-5 flex items-center gap-3">
          {refreshButton}
          {hint && <span className="text-[12.5px] text-faint">{hint}</span>}
        </div>
      )}
    </section>
  );
}

function LiveNumbers({ title, metrics }: { title: string; metrics: ReflectionMetricDto[] }) {
  return (
    <section>
      <div className="reflection-eyebrow">{title}</div>
      <MetricRow metrics={metrics} />
    </section>
  );
}

/** Small, secondary numbers. Deliberately not charts, and never a score. */
function MetricRow({ metrics }: { metrics: ReflectionMetricDto[] }) {
  return (
    <dl className="reflection-metrics">
      {metrics.map((metric) => (
        <div key={metric.key} title={metric.label}>
          <dt>{shortMetricLabel(metric)}</dt>
          <dd>{metric.display}</dd>
        </div>
      ))}
    </dl>
  );
}

const STATUS_LABELS: Record<Exclude<ReflectionPriorityDto['status'], 'archived'>, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
};

/**
 * What the user said matters, as Reflection understands it right now. A
 * priority is only compared against behaviour while it is active, so this is
 * where the user says "that one is done" without redoing onboarding.
 */
function Priorities({
  priorities,
  onSetStatus,
}: {
  priorities: ReflectionPriorityDto[];
  onSetStatus: (id: string, status: ReflectionPriorityDto['status']) => void;
}) {
  if (priorities.length === 0) return null;
  return (
    <section className="reflection-priorities">
      <div className="reflection-eyebrow">Priorities Reflect compares against</div>
      <ul className="mt-2 space-y-1.5">
        {priorities.map((priority) => (
          <li key={priority.id} className="flex items-center justify-between gap-4">
            <span className="min-w-0 text-[13.5px]">
              <span className={priority.status === 'active' ? 'text-default' : 'text-faint line-through'}>{priority.text}</span>
              {priority.possiblyStale && (
                <span className="text-faint"> · not reconfirmed in a while — still current?</span>
              )}
            </span>
            <select
              className="field text-[12.5px] py-1"
              aria-label={`Status of priority ${priority.text}`}
              value={priority.status}
              onChange={(e) => onSetStatus(priority.id, e.target.value as ReflectionPriorityDto['status'])}
            >
              {(Object.keys(STATUS_LABELS) as (keyof typeof STATUS_LABELS)[]).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-faint mt-2">Edit the list itself under Settings → Personalization.</p>
    </section>
  );
}
