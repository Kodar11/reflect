import type { FormEvent } from 'react';
import { ArrowUpRight, Loader2, Play } from 'lucide-react';
import { EvidenceList } from './InsightCard';
import {
  ACTION_TYPE_LABELS,
  DAYPART_OPTIONS,
  FAILURE_REASON_OPTIONS,
  MAX_DAY_START_MINUTES,
  MEMORY_KIND_LABELS,
  REASON_OPTIONS,
  SUGGESTED_PROMPTS,
  actionIndex,
  describeMessageChanges,
  minutesToTimeInput,
  promptFor,
  timeInputToMinutes,
  toneOf,
} from './coachView';
import { formatClockMinutes } from '../../reflection/ReflectionPeriods';
import type { TimelineTarget } from './reflectionView';

/**
 * Everything the Coach needs from the page. The page owns the requests; these
 * components only render what the main process handed over and report what
 * the user chose.
 */
export interface CoachController {
  state: CoachStateDto | null;
  /** Whether the day on screen is the live one (suggestions made in conversation belong to it). */
  live: boolean;
  /** The action a request is in flight for. */
  busyActionId: string | null;
  chatBusy: boolean;
  chatError: string | null;
  notice: string | null;
  onDecide: (actionId: string, decision: CoachDecisionDto, reason?: CoachReasonInputDto) => void;
  onEdit: (actionId: string, patch: CoachEditDto) => void;
  /** Whether it happened. */
  onExecution: (actionId: string, execution: CoachExecutionDto, reason?: CoachReasonInputDto) => void;
  /** Whether it helped. */
  onOutcome: (actionId: string, outcome: CoachOutcomeDto, reason?: CoachReasonInputDto) => void;
  onStartFocus: (action: CoachActionDto) => void;
  onSend: (text: string) => void;
  onRemoveMemory: (id: string) => void;
  onSaveSettings: (settings: Partial<CoachSettingsDto>) => void;
}

function fieldOf(event: FormEvent<HTMLFormElement>, name: string): string {
  return String(new FormData(event.currentTarget).get(name) ?? '').trim();
}

/**
 * "Why?" — optional, one click. A reason chip answers at once; the text field
 * is there for anyone who wants to say it in their own words.
 */
function ReasonPicker({
  label,
  options,
  disabled,
  onPick,
}: {
  label: string;
  options: { value: CoachReasonCodeDto; label: string }[];
  disabled: boolean;
  onPick: (reason: CoachReasonInputDto) => void;
}) {
  return (
    <details className="coach-more">
      <summary>{label}</summary>
      <div className="coach-reasons" role="group" aria-label={`${label}: why? (optional)`}>
        <span className="text-[12.5px] text-muted">Why? Optional.</span>
        <div className="coach-chips">
          {options.map((option) => (
            <button key={option.value} type="button" className="coach-chip" disabled={disabled} onClick={() => onPick({ reasonCode: option.value })}>
              {option.label}
            </button>
          ))}
          <button type="button" className="coach-chip" disabled={disabled} onClick={() => onPick({})}>
            No reason
          </button>
        </div>
        <form
          className="coach-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const note = fieldOf(e, 'note');
            onPick(note ? { reasonCode: 'other', note } : {});
          }}
        >
          <input name="note" className="field text-[13px]" placeholder="Or in your own words…" maxLength={400} aria-label="Reason, in your own words" />
          <button type="submit" className="btn btn-ghost text-[12.5px]" disabled={disabled}>
            Save
          </button>
        </form>
      </div>
    </details>
  );
}

function EditForm({ action, disabled, onEdit }: { action: CoachActionDto; disabled: boolean; onEdit: CoachController['onEdit'] }) {
  return (
    <details className="coach-more">
      <summary>Edit</summary>
      <form
        className="coach-edit"
        onSubmit={(e) => {
          e.preventDefault();
          const minutes = Number(fieldOf(e, 'minutes'));
          const when = fieldOf(e, 'when');
          onEdit(action.id, {
            title: fieldOf(e, 'title'),
            ...(action.focusMinutes !== null && Number.isFinite(minutes) && minutes > 0 ? { focusMinutes: minutes } : {}),
            ...(when === 'today' || when === 'tomorrow' ? { when } : {}),
            daypart: fieldOf(e, 'daypart') as CoachDaypartDto,
          });
          (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
        }}
      >
        <label className="coach-edit-wide">
          <span>What</span>
          <input name="title" className="field text-[13px]" defaultValue={action.title} maxLength={120} />
        </label>
        {action.focusMinutes !== null && (
          <label>
            <span>Minutes</span>
            <input name="minutes" type="number" className="field text-[13px]" defaultValue={action.focusMinutes} min={10} max={180} step={5} />
          </label>
        )}
        <label>
          <span>Day</span>
          <select name="when" className="field text-[13px]" defaultValue="">
            <option value="">Keep</option>
            <option value="today">Today</option>
            <option value="tomorrow">Tomorrow</option>
          </select>
        </label>
        <label>
          <span>When</span>
          <select name="daypart" className="field text-[13px]" defaultValue={action.daypart}>
            {DAYPART_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary text-[12.5px]" disabled={disabled}>
          Save changes
        </button>
      </form>
    </details>
  );
}

export interface CoachActionCardProps {
  action: CoachActionDto;
  coach: CoachController;
  period: ReflectionPeriodDto;
  onViewTimeline: (target: TimelineTarget) => void;
}

/**
 * One recommendation as a tracked thing: what it is, why, where it stands —
 * and exactly the question that is open about it. "Did it happen?" and "did it
 * help?" are asked separately, because they are different facts.
 */
export function CoachActionCard({ action, coach, period, onViewTimeline }: CoachActionCardProps) {
  const prompt = promptFor(action);
  const busy = coach.busyActionId === action.id;
  const focusButton = action.canStartFocus ? (
    <button type="button" className={prompt === 'committed' ? 'btn btn-primary' : 'btn btn-secondary'} disabled={busy} onClick={() => coach.onStartFocus(action)}>
      <Play size={13} />
      Start Focus{action.focusMinutes ? ` · ${action.focusMinutes} min` : ''}
    </button>
  ) : null;

  return (
    <article className="coach-action" data-status={action.status} data-tone={toneOf(action)} aria-busy={busy}>
      <div className="reflection-eyebrow">
        {ACTION_TYPE_LABELS[action.actionType] ?? 'Suggestion'}
        {action.targetLabel && prompt === 'decide' ? ` · ${action.targetLabel}` : ''}
      </div>
      <h3 className="text-[16px] font-semibold text-default mt-1.5 leading-snug">{action.title}</h3>
      {action.description && <p className="reflection-prose text-default mt-1.5">{action.description}</p>}
      {prompt === 'decide' && <p className="reflection-prose text-muted mt-1.5">{action.rationale}</p>}
      {action.adaptedFrom && prompt === 'decide' && (
        <p className="text-[12.5px] text-faint mt-1.5">Adapted from “{action.adaptedFrom}”, which did not work out as it was.</p>
      )}

      {prompt !== 'decide' && <p className="coach-status mt-2">{action.statusLine}</p>}
      {action.observation && action.observation.facts.length > 0 && prompt !== 'decide' && prompt !== 'committed' && (
        <ul className="coach-facts">
          {action.observation.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
      {action.note && <p className="text-[12.5px] text-muted mt-1.5">You said: “{action.note}”</p>}

      <div className="coach-controls">
        {prompt === 'decide' && (
          <>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => coach.onDecide(action.id, 'accept')}>
              Accept
            </button>
            {focusButton}
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onDecide(action.id, 'not_now')}>
              Not now
            </button>
            <ReasonPicker label="Reject" options={REASON_OPTIONS} disabled={busy} onPick={(reason) => coach.onDecide(action.id, 'reject', reason)} />
            <EditForm action={action} disabled={busy} onEdit={coach.onEdit} />
          </>
        )}

        {prompt === 'committed' && action.status === 'accepted' && (
          <>
            {focusButton}
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => coach.onExecution(action.id, 'done')}>
              Mark done
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onExecution(action.id, 'partial')}>
              Partly done
            </button>
            <ReasonPicker
              label="Didn’t do it"
              options={FAILURE_REASON_OPTIONS}
              disabled={busy}
              onPick={(reason) => coach.onExecution(action.id, 'not_done', reason)}
            />
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onOutcome(action.id, 'not_applicable')}>
              Not applicable
            </button>
            <EditForm action={action} disabled={busy} onEdit={coach.onEdit} />
          </>
        )}

        {prompt === 'committed' && action.status === 'snoozed' && (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => coach.onDecide(action.id, 'accept')}>
              Accept now
            </button>
            <ReasonPicker label="Reject" options={REASON_OPTIONS} disabled={busy} onPick={(reason) => coach.onDecide(action.id, 'reject', reason)} />
          </>
        )}

        {prompt === 'did_it_happen' && (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => coach.onExecution(action.id, 'done')}>
              I did it
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onExecution(action.id, 'partial')}>
              Partly
            </button>
            <ReasonPicker
              label="Didn’t do it"
              options={FAILURE_REASON_OPTIONS}
              disabled={busy}
              onPick={(reason) => coach.onExecution(action.id, 'not_done', reason)}
            />
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onOutcome(action.id, 'not_applicable')}>
              Not applicable
            </button>
          </>
        )}

        {prompt === 'did_it_help' && (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => coach.onOutcome(action.id, 'worked')}>
              Worked
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onOutcome(action.id, 'partly_worked')}>
              Partly worked
            </button>
            <ReasonPicker
              label="Didn’t work"
              options={FAILURE_REASON_OPTIONS}
              disabled={busy}
              onPick={(reason) => coach.onOutcome(action.id, 'did_not_work', reason)}
            />
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => coach.onOutcome(action.id, 'not_applicable')}>
              Not applicable
            </button>
            {action.executionSource === 'observed' && (
              <button type="button" className="reflection-link" disabled={busy} onClick={() => coach.onExecution(action.id, 'not_done')}>
                That’s not what happened
              </button>
            )}
          </>
        )}

        {prompt === 'settled' && action.status === 'closed' && (
          <details className="coach-more">
            <summary>Change this</summary>
            <div className="coach-chips mt-2">
              <button type="button" className="coach-chip" disabled={busy} onClick={() => coach.onExecution(action.id, 'done')}>
                I actually did it
              </button>
              <button type="button" className="coach-chip" disabled={busy} onClick={() => coach.onOutcome(action.id, 'worked')}>
                It worked
              </button>
              <button type="button" className="coach-chip" disabled={busy} onClick={() => coach.onOutcome(action.id, 'partly_worked')}>
                It partly worked
              </button>
              <button type="button" className="coach-chip" disabled={busy} onClick={() => coach.onOutcome(action.id, 'did_not_work')}>
                It didn’t work
              </button>
              <button type="button" className="coach-chip" disabled={busy} onClick={() => coach.onOutcome(action.id, 'not_applicable')}>
                Not applicable
              </button>
            </div>
          </details>
        )}
      </div>

      {action.evidence.length > 0 && (
        <div className="mt-2">
          <EvidenceList evidence={action.evidence} period={period} onViewTimeline={onViewTimeline} />
        </div>
      )}
    </article>
  );
}

/** A decided action in one line — used where the detail lives elsewhere on the page. */
export function CoachActionRow({ action }: { action: CoachActionDto }) {
  return (
    <li className="coach-row" data-tone={toneOf(action)}>
      <span className="text-default">{action.title}</span>
      <span className="text-muted"> — {action.statusLine}</span>
    </li>
  );
}

interface SectionProps {
  coach: CoachController;
  period: ReflectionPeriodDto;
  onViewTimeline: (target: TimelineTarget) => void;
}

/** What the user committed to, and what is waiting for their word. */
export function CoachCommitments({ coach, period, onViewTimeline }: SectionProps) {
  const commitments = coach.state?.commitments ?? [];
  if (commitments.length === 0) return null;
  return (
    <section className="coach-section" aria-label="Your commitments">
      <div className="reflection-eyebrow">Your commitments</div>
      <div className="space-y-5 mt-3">
        {commitments.map((action) => (
          <CoachActionCard key={action.id} action={action} coach={coach} period={period} onViewTimeline={onViewTimeline} />
        ))}
      </div>
    </section>
  );
}

/** Recently settled actions: what was tried and what came of it. */
export function CoachRecent({ coach, period, onViewTimeline }: SectionProps) {
  const recent = coach.state?.recent ?? [];
  if (recent.length === 0) return null;
  return (
    <section className="coach-section" aria-label="Recently">
      <details className="coach-more">
        <summary>
          Recently settled <span className="text-faint">· {recent.length}</span>
        </summary>
        <div className="space-y-5 mt-3">
          {recent.map((action) => (
            <CoachActionCard key={action.id} action={action} coach={coach} period={period} onViewTimeline={onViewTimeline} />
          ))}
        </div>
      </details>
    </section>
  );
}

/**
 * "What do you want to discuss?" — the same coach, asked directly. It answers
 * from the structured record; anything it changes is listed under its reply.
 */
export function CoachConversation({ coach, onViewTimeline }: Pick<SectionProps, 'coach' | 'onViewTimeline'>) {
  const state = coach.state;
  if (!state) return null;
  const index = actionIndex(state);
  const titleOf = (id: string) => index.get(id)?.title ?? null;
  const messages = state.messages.slice(-12);
  const disabled = coach.chatBusy || !state.configured;

  return (
    <section className="coach-section" aria-label="Talk to the coach">
      <div className="reflection-eyebrow">What do you want to discuss?</div>

      {messages.length > 0 && (
        <ol className="coach-chat" aria-live="polite">
          {messages.map((message) => (
            <li key={message.id} className="coach-msg" data-role={message.role} data-kind={message.meta?.kind ?? undefined}>
              <div className="coach-msg-who">{message.role === 'user' ? 'You' : message.meta?.kind === 'question' ? 'Reflect asks' : 'Reflect'}</div>
              <p className="reflection-prose">{message.text}</p>
              {describeMessageChanges(message, titleOf).map((change) => (
                <div key={change} className="coach-msg-change">
                  {change}
                </div>
              ))}
              {message.meta?.correction && (
                <button
                  type="button"
                  className="reflection-link mt-1"
                  onClick={() =>
                    onViewTimeline({ day: message.meta!.correction!.start, view: 'day', activityId: message.meta!.correction!.activityId })
                  }
                >
                  Correct “{message.meta.correction.title}” in the timeline
                  <ArrowUpRight size={12} />
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {coach.chatBusy && (
        <div className="reflection-state" role="status" style={{ padding: '10px 0' }}>
          <Loader2 size={14} className="animate-spin" />
          Looking at your record…
        </div>
      )}
      {coach.chatError && (
        <div className="reflection-banner mt-3" role="alert">
          {coach.chatError}
        </div>
      )}

      {messages.length === 0 && state.configured && (
        <div className="coach-chips mt-3">
          {SUGGESTED_PROMPTS.map((prompt) => (
            <button key={prompt} type="button" className="coach-chip" disabled={disabled} onClick={() => coach.onSend(prompt)}>
              {prompt}
            </button>
          ))}
        </div>
      )}

      <form
        className="coach-inline-form mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          const text = fieldOf(e, 'message');
          if (!text) return;
          coach.onSend(text);
          e.currentTarget.reset();
        }}
      >
        <input
          name="message"
          className="field text-[14px]"
          maxLength={1000}
          disabled={disabled}
          placeholder={
            state.question ? 'Answer in your own words…' : state.configured ? 'Ask about your days, or tell Reflect what happened…' : 'The coach needs Gemini to answer'
          }
          aria-label="Message to the coach"
          autoComplete="off"
        />
        <button type="submit" className="btn btn-primary" disabled={disabled}>
          {state.question ? 'Answer' : 'Ask'}
        </button>
      </form>
      {!state.configured && (
        <p className="text-[12.5px] text-faint mt-2">Add a Gemini API key to talk to the coach. Your commitments are still tracked without it.</p>
      )}
    </section>
  );
}

/** What Reflect has learned and what it remembers — inspectable, and removable. */
export function CoachKnowledge({ coach }: Pick<SectionProps, 'coach'>) {
  const state = coach.state;
  if (!state || (state.learned.length === 0 && state.memory.length === 0)) return null;
  return (
    <section className="coach-section" aria-label="What Reflect remembers">
      <details className="coach-more">
        <summary>
          What Reflect has learned and remembers <span className="text-faint">· {state.learned.length + state.memory.length}</span>
        </summary>
        {state.learned.length > 0 && (
          <ul className="coach-learned">
            {state.learned.map((item) => (
              <li key={item.text} data-kind={item.kind}>
                {item.text}
              </li>
            ))}
          </ul>
        )}
        {state.memory.length > 0 && (
          <ul className="coach-memory">
            {state.memory.map((memory) => (
              <li key={memory.id}>
                <span className="min-w-0">
                  <span className="text-faint">{MEMORY_KIND_LABELS[memory.kind]} · </span>
                  <span className="text-default">{memory.text}</span>
                  <span className="text-faint"> · {memory.source === 'user' ? 'you said this' : 'from your record'}</span>
                </span>
                <button type="button" className="reflection-link shrink-0" onClick={() => coach.onRemoveMemory(memory.id)}>
                  Forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}

/** When the day's reflection is written, and when the user's day begins. */
export function CoachSettings({ coach }: Pick<SectionProps, 'coach'>) {
  const settings = coach.state?.settings;
  if (!settings) return null;
  return (
    <section className="coach-section" aria-label="Reflection schedule">
      <details className="coach-more">
        <summary>
          Daily reflection <span className="text-faint">· written around {formatClockMinutes(settings.reflectionMinutes)}</span>
        </summary>
        <div className="coach-settings">
          <label>
            <span>Write my reflection at</span>
            <input
              type="time"
              className="field text-[13px]"
              defaultValue={minutesToTimeInput(settings.reflectionMinutes)}
              onBlur={(e) => {
                const minutes = timeInputToMinutes(e.currentTarget.value);
                if (minutes !== null && minutes !== settings.reflectionMinutes) coach.onSaveSettings({ reflectionMinutes: minutes });
              }}
            />
          </label>
          <label>
            <span>My day starts at</span>
            <input
              type="time"
              className="field text-[13px]"
              defaultValue={minutesToTimeInput(settings.dayStartMinutes)}
              max={minutesToTimeInput(MAX_DAY_START_MINUTES)}
              onBlur={(e) => {
                const minutes = timeInputToMinutes(e.currentTarget.value);
                if (minutes !== null && minutes <= MAX_DAY_START_MINUTES && minutes !== settings.dayStartMinutes) {
                  coach.onSaveSettings({ dayStartMinutes: minutes });
                }
              }}
            />
          </label>
          <label className="coach-settings-check">
            <input
              type="checkbox"
              defaultChecked={settings.notifyDailyReflection}
              onChange={(e) => coach.onSaveSettings({ notifyDailyReflection: e.currentTarget.checked })}
            />
            <span>Tell me when it is ready</span>
          </label>
          <p className="text-[12px] text-faint">
            Work past midnight? Set your day to start later (up to 6 AM) and those hours count toward the day before. Reflect may write the
            reflection a little early once the day has clearly wound down.
          </p>
        </div>
      </details>
    </section>
  );
}
