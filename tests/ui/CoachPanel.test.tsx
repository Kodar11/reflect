import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CoachActionCard, CoachConversation, CoachKnowledge, CoachSettings } from '../../src/ui/Reflection/CoachPanel';
import { ReflectionContent, type ReflectionContentProps } from '../../src/ui/Reflection/ReflectionContent';
import {
  actionIndex,
  describeMessageChanges,
  groupInsights,
  minutesToTimeInput,
  nextActions,
  promptFor,
  timeInputToMinutes,
  toneOf,
} from '../../src/ui/Reflection/coachView';
import {
  acceptedAction,
  coachAction,
  coachState,
  controller,
  dailyReport,
  dailyView,
  day12,
  observedAction,
  settledAction,
  unobservedAction,
} from './coachFixtures';
import { insight, makeView } from './reflectionFixtures';

/**
 * The Coach inside the Reflection tab, rendered for real (server-side, no DOM
 * needed). Interaction is covered by walking the rendered element tree and
 * invoking the handlers the user would trigger.
 */

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** Depth-first search of a rendered React element tree. */
function findAll(node: unknown, match: (el: ReactElement) => boolean, found: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, found);
    return found;
  }
  if (!node || typeof node !== 'object' || !('props' in (node as object))) return found;
  let el = node as ReactElement;
  // Expand function components so their output is searchable too.
  while (typeof el.type === 'function') {
    el = (el.type as (p: unknown) => ReactElement)(el.props);
    if (!el || typeof el !== 'object') return found;
  }
  if (match(el)) found.push(el);
  findAll((el.props as { children?: unknown }).children, match, found);
  return found;
}

const label = (el: ReactElement) => text(renderToStaticMarkup(el));
const buttons = (tree: ReactElement) => findAll(tree, (el) => el.type === 'button');
const click = (tree: ReactElement, name: string) => {
  const button = buttons(tree).find((b) => label(b) === name);
  if (!button) throw new Error(`No button "${name}" in: ${buttons(tree).map(label).join(' | ')}`);
  (button.props as { onClick: () => void }).onClick();
};
/** Submit a form with the given field values (what `FormData` would read). */
function submit(form: ReactElement, fields: Record<string, string>) {
  const original = globalThis.FormData;
  const target = { reset: vi.fn(), closest: () => null };
  globalThis.FormData = class {
    get(name: string) {
      return fields[name] ?? null;
    }
  } as unknown as typeof FormData;
  try {
    (form.props as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault() {}, currentTarget: target });
  } finally {
    globalThis.FormData = original;
  }
  return target;
}

const card = (action: CoachActionDto, coach = controller()) => (
  <CoachActionCard action={action} coach={coach} period={day12} onViewTimeline={vi.fn()} />
);

function contentProps(overrides: Partial<ReflectionContentProps> = {}): ReflectionContentProps {
  return {
    view: dailyView(),
    loading: false,
    error: null,
    busy: false,
    notice: null,
    onRefresh: vi.fn(),
    onRetryLoad: vi.fn(),
    onFeedback: vi.fn(),
    onViewTimeline: vi.fn(),
    onSetPriorityStatus: vi.fn(),
    coach: controller({ state: coachState({ reportActions: [coachAction()], next: [coachAction()] }) }),
    ...overrides,
  };
}

describe('coach view logic', () => {
  it('groups a day\'s insights the way a briefing reads', () => {
    const groups = groupInsights(dailyReport().insights);
    expect(groups.standsOut.map((i) => i.id)).toEqual(['i-progress']);
    expect(groups.changed.map((i) => i.id)).toEqual(['i-change']);
    expect(groups.priorities.map((i) => i.id)).toEqual(['i-priority']);
  });

  it('decides what "Next" shows for a report', () => {
    const fromReport = coachAction();
    const decided = acceptedAction({ reportId: 'r-day' });
    const fromChat = coachAction({ id: 'act-chat', source: 'conversation', reportId: null });
    const state = coachState({ reportActions: [fromReport, decided, coachAction({ id: 'gone', status: 'withdrawn' })], next: [fromReport, fromChat] });

    // On the live day: this report's suggestions plus any made in conversation.
    expect(nextActions({ id: 'r-day' }, state, true)).toEqual({ undecided: [fromReport, fromChat], decided: [decided] });
    // Browsing an earlier day: only what that report itself suggested.
    expect(nextActions({ id: 'r-day' }, state, false).undecided).toEqual([fromReport]);
    expect(nextActions({ id: 'another' }, state, false)).toEqual({ undecided: [], decided: [] });
    expect(nextActions(null, null, true)).toEqual({ undecided: [], decided: [] });
  });

  it('asks exactly the open question for an action\'s state', () => {
    expect(promptFor(coachAction())).toBe('decide');
    expect(promptFor(acceptedAction())).toBe('committed');
    expect(promptFor(unobservedAction())).toBe('did_it_happen');
    expect(promptFor(observedAction())).toBe('did_it_help');
    expect(promptFor(settledAction())).toBe('settled');
    expect(promptFor(coachAction({ status: 'rejected', pending: null }))).toBe('settled');
    expect([toneOf(settledAction()), toneOf(settledAction({ outcome: 'did_not_work' })), toneOf(acceptedAction())]).toEqual(['good', 'bad', 'neutral']);
  });

  it('converts the reflection time to and from a time input', () => {
    expect(minutesToTimeInput(22 * 60)).toBe('22:00');
    expect(minutesToTimeInput(90)).toBe('01:30');
    expect(timeInputToMinutes('21:15')).toBe(1275);
    expect(timeInputToMinutes('4:00')).toBe(240);
    expect([timeInputToMinutes(''), timeInputToMinutes('25:00'), timeInputToMinutes('nonsense')]).toEqual([null, null, null]);
  });

  it('describes what a reply changed, in the user\'s words', () => {
    const state = coachState({ commitments: [acceptedAction({ id: 'a', title: 'Protect the morning' })] });
    const titleOf = (id: string) => actionIndex(state).get(id)?.title ?? null;
    const meta = { actions: [{ actionId: 'a', change: 'marked as done' }, { actionId: 'unknown', change: 'suggested' }] };
    expect(describeMessageChanges({ meta }, titleOf)).toEqual(['“Protect the morning” — marked as done', 'An action was suggested']);
    expect(describeMessageChanges({ meta: null }, titleOf)).toEqual([]);
  });
});

describe('a recommendation waiting for a decision', () => {
  const coach = controller();
  const tree = card(coachAction(), coach);
  const read = text(renderToStaticMarkup(tree));

  it('shows what it is, when, and the evidence-based reason', () => {
    expect(read).toContain('Focus session · Tomorrow · morning');
    expect(read).toContain('Run one 45-minute Focus session on Project X before switching threads');
    expect(read).toContain('Your longest block on Project X started in the morning');
    expect(read).toContain('Evidence · 1');
  });

  it('makes the decision one click: accept, not now, reject, edit — and Start Focus', () => {
    expect(buttons(tree).map(label).slice(0, 3)).toEqual(['Accept', 'Start Focus · 45 min', 'Not now']);
    click(tree, 'Accept');
    expect(coach.onDecide).toHaveBeenCalledWith('act-1', 'accept');
    click(tree, 'Not now');
    expect(coach.onDecide).toHaveBeenCalledWith('act-1', 'not_now');
    click(tree, 'Start Focus · 45 min');
    expect(coach.onStartFocus).toHaveBeenCalledWith(expect.objectContaining({ id: 'act-1', focusMinutes: 45 }));
  });

  it('rejecting offers lightweight reasons, never a long form', () => {
    expect(read).toContain('Reject');
    expect(read).toContain('Why? Optional.');
    for (const reason of ['Not relevant', 'Bad timing', 'Too difficult', 'Different priority', 'Already doing it', 'No reason']) expect(read).toContain(reason);

    click(tree, 'Bad timing');
    expect(coach.onDecide).toHaveBeenLastCalledWith('act-1', 'reject', { reasonCode: 'bad_timing' });
    click(tree, 'No reason');
    expect(coach.onDecide).toHaveBeenLastCalledWith('act-1', 'reject', {});

    // Optional free text.
    const [reasonForm] = findAll(tree, (el) => el.type === 'form');
    submit(reasonForm, { note: 'Exam week' });
    expect(coach.onDecide).toHaveBeenLastCalledWith('act-1', 'reject', { reasonCode: 'other', note: 'Exam week' });
  });

  it('editing changes what, how long and when', () => {
    const forms = findAll(tree, (el) => el.type === 'form');
    submit(forms[1], { title: 'A shorter Project X block', minutes: '25', when: 'tomorrow', daypart: 'afternoon' });
    expect(coach.onEdit).toHaveBeenCalledWith('act-1', { title: 'A shorter Project X block', focusMinutes: 25, when: 'tomorrow', daypart: 'afternoon' });
  });

  it('says what an adapted suggestion was adapted from', () => {
    expect(text(renderToStaticMarkup(card(coachAction({ adaptedFrom: 'A morning block on Project X' }))))).toContain(
      'Adapted from “A morning block on Project X”, which did not work out as it was.',
    );
  });

  it('is inert while a request for it is in flight', () => {
    const busy = card(coachAction(), controller({ busyActionId: 'act-1' }));
    // Every control of the card (evidence links aside) waits for the answer.
    const controls = buttons(busy).filter((b) => label(b) !== 'View in timeline');
    expect(controls.length).toBeGreaterThan(8);
    expect(controls.every((b) => (b.props as { disabled?: boolean }).disabled === true)).toBe(true);
    expect(renderToStaticMarkup(busy)).toContain('aria-busy="true"');
  });
});

describe('a commitment — did it happen, and did it help, asked separately', () => {
  it('accepted: can be started through Focus, or settled by hand', () => {
    const coach = controller();
    const tree = card(acceptedAction(), coach);
    expect(text(renderToStaticMarkup(tree))).toContain('Accepted · Tomorrow · morning');
    click(tree, 'Start Focus · 45 min');
    expect(coach.onStartFocus).toHaveBeenCalled();
    click(tree, 'Mark done');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-accepted', 'done');
    click(tree, 'Partly done');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-accepted', 'partial');
  });

  it('accepted: "didn\'t do it" takes an optional reason; "not applicable" is one click', () => {
    const coach = controller();
    const tree = card(acceptedAction(), coach);
    click(tree, 'Something outside my control');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-accepted', 'not_done', { reasonCode: 'external_constraint' });
    click(tree, 'Not applicable');
    expect(coach.onOutcome).toHaveBeenLastCalledWith('act-accepted', 'not_applicable');
  });

  it('observed: shows what Reflect saw and asks only whether it helped', () => {
    const coach = controller();
    const tree = card(observedAction(), coach);
    const read = text(renderToStaticMarkup(tree));
    expect(read).toContain('Carried out (observed) — did it help?');
    expect(read).toContain('Focus session “Project X” ran 42m of 45m planned, 1 interruption.');
    expect(read).not.toContain('I did it'); // Reflect already knows it happened

    click(tree, 'Worked');
    expect(coach.onOutcome).toHaveBeenLastCalledWith('act-observed', 'worked');
    click(tree, 'Partly worked');
    expect(coach.onOutcome).toHaveBeenLastCalledWith('act-observed', 'partly_worked');
    click(tree, 'Too difficult');
    expect(coach.onOutcome).toHaveBeenLastCalledWith('act-observed', 'did_not_work', { reasonCode: 'too_difficult' });
    // And the user can overrule what Reflect inferred.
    click(tree, 'That’s not what happened');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-observed', 'not_done');
  });

  it('not observed: states it without judgment and asks whether it happened', () => {
    const coach = controller();
    const tree = card(unobservedAction(), coach);
    const read = text(renderToStaticMarkup(tree));
    expect(read).toContain('Not observed — did it happen?');
    expect(read).toContain('Nothing matching was observed between Tue, Oct 13, 5:00 AM and 12:00 PM.');
    expect(read).not.toMatch(/failed|missed|skipped/i);

    click(tree, 'I did it');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-unobserved', 'done');
    click(tree, 'Bad timing');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-unobserved', 'not_done', { reasonCode: 'bad_timing' });
  });

  it('settled: shows the result, and still lets the user correct it', () => {
    const coach = controller();
    const tree = card(settledAction({ note: 'Got the sync engine merged' }), coach);
    const read = text(renderToStaticMarkup(tree));
    expect(read).toContain('Carried out · it worked');
    expect(read).toContain('You said: “Got the sync engine merged”');
    click(tree, 'It didn’t work');
    expect(coach.onOutcome).toHaveBeenLastCalledWith('act-settled', 'did_not_work');
    click(tree, 'I actually did it');
    expect(coach.onExecution).toHaveBeenLastCalledWith('act-settled', 'done');
  });
});

describe('the conversation', () => {
  it('offers a few questions to start from, and sends what the user asks', () => {
    const coach = controller();
    const tree = <CoachConversation coach={coach} onViewTimeline={vi.fn()} />;
    const read = text(renderToStaticMarkup(tree));
    expect(read).toContain('What do you want to discuss?');
    expect(read).toContain('What should I focus on tomorrow?');

    click(tree, 'What did I decide last week?');
    expect(coach.onSend).toHaveBeenLastCalledWith('What did I decide last week?');

    const [form] = findAll(tree, (el) => el.type === 'form');
    const target = submit(form, { message: 'Why do I keep failing to work on Project X?' });
    expect(coach.onSend).toHaveBeenLastCalledWith('Why do I keep failing to work on Project X?');
    expect(target.reset).toHaveBeenCalled();
    submit(form, { message: '   ' });
    expect(coach.onSend).toHaveBeenCalledTimes(2);
  });

  it('shows the exchange, what a reply changed, and the way to correct a misread activity', () => {
    const onViewTimeline = vi.fn();
    const state = coachState({
      commitments: [acceptedAction({ id: 'a', title: 'Protect the morning' })],
      messages: [
        { id: 'm1', role: 'user', text: 'I did the morning block. Also the 9 AM block was not Project Y.', meta: null, createdAt: '' },
        {
          id: 'm2',
          role: 'coach',
          text: 'Recorded. You can correct that block in the Timeline.',
          meta: {
            kind: 'reply',
            actions: [{ actionId: 'a', change: 'marked as done' }],
            correction: { activityId: 'ai-13-0', title: 'Fix Project Y billing bug', start: '2026-10-13T03:30:00.000Z', end: '2026-10-13T04:30:00.000Z' },
          },
          createdAt: '',
        },
      ],
    });
    const tree = <CoachConversation coach={controller({ state })} onViewTimeline={onViewTimeline} />;
    const read = text(renderToStaticMarkup(tree));
    expect(read).toContain('You I did the morning block.');
    expect(read).toContain('Reflect Recorded.');
    expect(read).toContain('“Protect the morning” — marked as done');
    expect(read).not.toContain('What should I focus on tomorrow?'); // suggestions only before the first turn

    click(tree, 'Correct “Fix Project Y billing bug” in the timeline');
    expect(onViewTimeline).toHaveBeenCalledWith({ day: '2026-10-13T03:30:00.000Z', view: 'day', activityId: 'ai-13-0' });
  });

  it('presents a question the Coach is waiting on, and asks for an answer', () => {
    const state = coachState({
      question: { messageId: 'q', text: 'What keeps getting in the way?', actionId: null },
      messages: [{ id: 'q', role: 'coach', text: '3 suggestions about “Project X” have not worked out. What keeps getting in the way?', meta: { kind: 'question' }, createdAt: '' }],
    });
    const markup = renderToStaticMarkup(<CoachConversation coach={controller({ state })} onViewTimeline={vi.fn()} />);
    expect(text(markup)).toContain('Reflect asks 3 suggestions about “Project X” have not worked out.');
    expect(markup).toContain('data-kind="question"');
    expect(markup).toContain('placeholder="Answer in your own words…"');
    expect(text(markup)).toContain('Answer');
  });

  it('shows a recoverable error, a busy state, and degrades without Gemini', () => {
    const failed = text(renderToStaticMarkup(<CoachConversation coach={controller({ chatError: 'Reflect could not reach Gemini. Nothing was changed — try again in a moment.' })} onViewTimeline={vi.fn()} />));
    expect(failed).toContain('Reflect could not reach Gemini. Nothing was changed');

    const busy = renderToStaticMarkup(<CoachConversation coach={controller({ chatBusy: true })} onViewTimeline={vi.fn()} />);
    expect(text(busy)).toContain('Looking at your record…');
    expect(busy).toMatch(/<input[^>]*disabled/);

    const offline = renderToStaticMarkup(<CoachConversation coach={controller({ state: coachState({ configured: false }) })} onViewTimeline={vi.fn()} />);
    expect(text(offline)).toContain('Add a Gemini API key to talk to the coach. Your commitments are still tracked without it.');
    expect(text(offline)).not.toContain('What should I focus on tomorrow?');
  });
});

describe('what Reflect has learned and remembers', () => {
  it('is inspectable, and every memory can be forgotten', () => {
    const coach = controller({
      state: coachState({
        learned: [{ kind: 'works', text: 'A Focus session (up to an hour) in the morning for “Project X” has helped 3 of 4 times.' }],
        memory: [{ id: 'mem-1', kind: 'constraint', text: 'Weekday mornings are classes until 11.', source: 'user', createdAt: '' }],
      }),
    });
    const tree = <CoachKnowledge coach={coach} />;
    const read = text(renderToStaticMarkup(tree));
    expect(read).toContain('What Reflect has learned and remembers · 2');
    expect(read).toContain('has helped 3 of 4 times.');
    expect(read).toContain('Constraint · Weekday mornings are classes until 11. · you said this');
    click(tree, 'Forget');
    expect(coach.onRemoveMemory).toHaveBeenCalledWith('mem-1');
    expect(renderToStaticMarkup(<CoachKnowledge coach={controller()} />)).toBe('');
  });

  it('lets the user set when the day ends and when the reflection is written', () => {
    const coach = controller();
    const tree = <CoachSettings coach={coach} />;
    expect(text(renderToStaticMarkup(tree))).toContain('Daily reflection · written around 10:00 PM');
    const inputs = findAll(tree, (el) => el.type === 'input');
    const blur = (input: ReactElement, value: string) => (input.props as { onBlur: (e: unknown) => void }).onBlur({ currentTarget: { value } });

    blur(inputs[0], '21:15');
    expect(coach.onSaveSettings).toHaveBeenLastCalledWith({ reflectionMinutes: 1275 });
    blur(inputs[0], '22:00'); // unchanged
    blur(inputs[1], '04:00');
    expect(coach.onSaveSettings).toHaveBeenLastCalledWith({ dayStartMinutes: 240 });
    blur(inputs[1], '09:00'); // a day cannot start that late
    expect(coach.onSaveSettings).toHaveBeenCalledTimes(2);
    (inputs[2].props as { onChange: (e: unknown) => void }).onChange({ currentTarget: { checked: false } });
    expect(coach.onSaveSettings).toHaveBeenLastCalledWith({ notifyDailyReflection: false });
  });
});

describe('the daily briefing', () => {
  const markup = renderToStaticMarkup(<ReflectionContent {...contentProps()} />);
  const read = text(markup);

  it('reads top to bottom: what happened → stands out → changed → priorities → planned → next → discuss', () => {
    const order = [
      'What happened',
      'Project X took your morning; the afternoon moved between threads.',
      'You started with a long stretch on Project X.',
      'What stands out',
      'What changed',
      'What this means for your priorities',
      'What you had planned',
      'What Reflect is not sure about',
      'Next',
      'What do you want to discuss?',
      'Supporting numbers',
    ].map((heading) => read.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('shows the follow-up on an earlier commitment and what was learned', () => {
    expect(read).toContain('Protect the first hour for Project X');
    expect(read).toContain('The Focus session ran 42m of the 45m planned.');
    expect(read).toContain('A morning block on Project X is realistic for you.');
    expect(read).toContain('I am not sure whether the afternoon research belonged to Project X.');
  });

  it('offers one recommendation with Accept / Not now / Edit — not a checklist', () => {
    expect((markup.match(/class="coach-action"/g) ?? []).length).toBe(1);
    for (const control of ['Accept', 'Not now', 'Reject', 'Edit']) expect(read).toContain(control);
    // The single carry-forward gave way to the tracked action.
    expect(read).not.toContain('Carry forward');
  });

  it('is not a dashboard: no scores, charts or rankings', () => {
    expect(markup).not.toMatch(/<canvas|<progress|<meter|score|ranking|badge|streak|leaderboard/i);
  });

  it('"No suggestion today" is shown as an answer, with its reason', () => {
    const report = dailyReport({ coach: { actionIds: [], followups: [], uncertainty: [], noActionReason: 'Your time went where you said it matters.', question: null } });
    const none = text(renderToStaticMarkup(<ReflectionContent {...contentProps({ view: dailyView({ report }), coach: controller() })} />));
    expect(none).toContain('No suggestion today. Your time went where you said it matters.');
    expect(none).not.toContain('What you had planned');
  });

  it('shows decided actions of the report as one line each, and commitments in full', () => {
    const decided = acceptedAction({ reportId: 'r-day' });
    const coach = controller({ state: coachState({ reportActions: [decided], commitments: [decided, observedAction()] }) });
    const out = text(renderToStaticMarkup(<ReflectionContent {...contentProps({ coach })} />));
    expect(out).toContain('Run one 45-minute Focus session on Project X before switching threads — Accepted · Tomorrow · morning');
    expect(out).toContain('Your commitments');
    expect(out).toContain('Carried out (observed) — did it help?');
  });

  it('an older daily reflection, written before the Coach, still shows its carry-forward', () => {
    const old = dailyReport({ coach: null, carryForward: { text: 'Keep a morning block for Project X.', evidence: [] } });
    const out = text(renderToStaticMarkup(<ReflectionContent {...contentProps({ view: dailyView({ report: old }), coach: controller() })} />));
    expect(out).toContain('Keep a morning block for Project X.');
  });

  it('before today\'s reflection exists, commitments and the conversation are already there', () => {
    const view = dailyView({ report: null, live: { asOf: '', metrics: [{ key: 'time.tracked_minutes', label: 'Total tracked time', display: '1h 05m' }] } });
    const coach = controller({ state: coachState({ commitments: [acceptedAction()], next: [coachAction({ id: 'from-chat', source: 'conversation', reportId: null })] }) });
    const out = text(renderToStaticMarkup(<ReflectionContent {...contentProps({ view, coach })} />));
    expect(out).toContain('Today’s reflection has not been written yet.');
    expect(out).toContain('Reflect writes it around 10:00 PM');
    expect(out).toContain('Your commitments');
    expect(out).toContain('Start Focus · 45 min');
    expect(out).toContain('What do you want to discuss?');
    // A suggestion made in conversation waits under "Next" even without a report.
    expect((renderToStaticMarkup(<ReflectionContent {...contentProps({ view, coach })} />).match(/aria-label="Next"/g) ?? []).length).toBe(1);
  });

  it('tells the user when a change could not be saved', () => {
    const out = text(renderToStaticMarkup(<ReflectionContent {...contentProps({ coach: controller({ notice: 'That change could not be saved.' }) })} />));
    expect(out).toContain('That change could not be saved.');
  });

  it('weeks, months and years are unchanged: no coach, one carry-forward', () => {
    const weekly = text(renderToStaticMarkup(<ReflectionContent {...contentProps({ view: makeView(), coach: controller() })} />));
    expect(weekly).toContain('Carry forward');
    expect(weekly).not.toContain('What do you want to discuss?');
    expect(weekly).not.toContain('What happened');
  });

  it('an insight marked "not accurate" points to the Timeline, where the correction teaches Reflect', () => {
    const onViewTimeline = vi.fn();
    const wrong = insight({ id: 'i-wrong', feedback: 'inaccurate' });
    const view = dailyView({ report: dailyReport({ insights: [wrong] }) });
    const tree = <ReflectionContent {...contentProps({ view, onViewTimeline, coach: controller() })} />;
    expect(text(renderToStaticMarkup(tree))).toContain('If an activity was misread, correct it in the timeline — the next reflection will use your correction.');
    click(tree, 'correct it in the timeline');
    expect(onViewTimeline).toHaveBeenCalledWith(expect.objectContaining({ activityId: 'ai-12-0', view: 'day' }));
  });
});
