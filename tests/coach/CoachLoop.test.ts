import { describe, it, expect } from 'vitest';
import type { ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import {
  browsing,
  focusSession,
  iso,
  local,
  makeReflectionHarness,
  modelInsight,
  projectX,
  projectY,
  research,
  seedThreads,
  workday,
} from '../reflection/helpers';
import { modelAction, modelChat, modelDay } from './helpers';

/**
 * The whole loop, end to end, with scripted Gemini responses and everything
 * else real:
 *
 *   daily evidence → intelligence → recommendation → user decision
 *     → execution tracking → outcome → memory → next recommendation
 */

const day = (d: number) => periodContaining('day', local(d));
/** A day with no Project X at all. */
const quiet = (d: number) => [projectY(d, '09:00', 60), research(d, '10:30', 40), browsing(d, '13:00', 30)];

function harness(extraDays: (d: number) => ReturnType<typeof quiet>, days: number[]) {
  const h = makeReflectionHarness({
    activities: [...[5, 6, 7, 8, 9, 12].flatMap(workday), ...days.flatMap(extraDays)],
    now: local(12, '22:05'),
    priorities: ['Launching Project X'],
    coach: true,
  });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0].id });
  return { ...h, priorityId: priorities[0].id };
}

/** A day's response when the day held no Project X (so no Project X metric exists to cite). */
const quietResponse = (period: ReflectionPeriod, coach: Record<string, unknown>) =>
  modelDay(period, coach, {
    headline: 'Today went to Project Y and research.',
    narrative: null,
    insights: [
      modelInsight({
        title: 'Project Y took the morning',
        observation: 'Project Y received the largest share of your tracked time today.',
        interpretation: 'Your sustained attention went to one thread.',
        metricKeys: ['thread.project-y.minutes'],
      }),
    ],
  });

/** The lines of a prompt section, for reading what the model was shown. */
const section = (prompt: string, heading: string) => {
  const start = prompt.indexOf(heading);
  return start < 0 ? '' : prompt.slice(start).split('\n\n')[0];
};

describe('the coach loop — a recommendation that works', () => {
  it('suggest → accept → Focus session → observed → "it worked" → the next day knows', async () => {
    const h = harness((d) => [projectX(d, '09:00', 45), ...quiet(d)], [13, 14]);

    // ── Mon evening: the day's intelligence suggests one thing.
    h.gemini.push(modelDay(day(12)));
    await h.service.generate(day(12), { trigger: 'scheduled' });
    let state = h.coach.getState(h.repo.getCurrentReport('day', day(12).key)!.id);
    expect(state.next).toHaveLength(1);
    const first = state.next[0];
    expect(first).toMatchObject({ status: 'suggested', pending: 'decision', targetLabel: 'Tomorrow · morning', canStartFocus: true });
    expect(state.reportActions.map((a) => a.id)).toEqual([first.id]);

    // ── The user accepts: it is now a commitment Reflect watches for.
    h.setNow(local(12, '22:10'));
    expect(h.coach.decide(first.id, 'accept')).toMatchObject({ ok: true, action: { status: 'accepted', statusLine: 'Accepted · Tomorrow · morning' } });
    expect(h.coach.getState()).toMatchObject({ next: [], commitments: [{ id: first.id, pending: null }] });

    // ── Tue 9:00: they start it from the card. Focus is the execution mechanism.
    h.setNow(local(13, '09:00'));
    const session = focusSession(13, '09:00', 45, { state: 'active', endedAt: null, endReason: null, elapsedMs: 0 });
    h.focusSessions.push(session);
    expect(h.coach.linkFocus(first.id)).toMatchObject({ ok: true });
    expect(h.coachRepo.getAction(first.id)!.linkedFocusSessionId).toBe(session.id);

    // ── 9:45: the session ends; one interruption on the way.
    Object.assign(session, { state: 'completed', endedAt: iso(13, '09:45'), endReason: 'completed', elapsedMs: 45 * 60_000 });
    h.interruptions[session.id] = [{ id: 'i1', sessionId: session.id, type: 'pause', reason: null, occurredAt: iso(13, '09:20'), idleMs: null, createdAt: iso(13, '09:20') }];
    h.setNow(local(13, '09:46'));
    await h.coach.onFocusEnded();

    // Reflect observed the execution itself. Whether it HELPED is a separate question.
    const observed = h.coachRepo.getAction(first.id)!;
    expect(observed).toMatchObject({ status: 'review', execution: 'done', executionSource: 'observed', outcome: null });
    expect(observed.observation!.facts).toEqual(['Focus session “Project X” ran 45m of 45m planned, 1 interruption.', expect.stringContaining('of tracked work on “Project X”')]);
    expect(h.coach.getState().commitments[0]).toMatchObject({ pending: 'outcome', statusLine: 'Carried out (observed) — did it help?' });

    // ── The user says it worked.
    h.setNow(local(13, '18:00'));
    expect(h.coach.reportOutcome(first.id, 'worked', { note: 'Got the sync engine merged' })).toMatchObject({
      ok: true,
      action: { status: 'closed', outcome: 'worked', statusLine: 'Carried out · it worked' },
    });

    // ── Tue evening: the next daily pass is told exactly what happened.
    h.setNow(local(13, '22:05'));
    h.gemini.push(
      modelDay(day(13), {
        followups: [{ actionRef: 'k1', note: 'The Focus session ran 45m of the 45m planned, with 1 interruption, and you said it worked.', learned: 'A morning block on Project X is realistic for you.' }],
        actions: [modelAction({ actionType: 'continue_behavior', metricKeys: [], actionRefs: ['k1'], rationale: 'The morning block on Project X happened as planned and you said it helped.' })],
      }),
    );
    expect(await h.service.generate(day(13), { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });

    const previous = section(h.gemini.requests[1].prompt, 'PREVIOUS ACTIONS');
    expect(previous).toContain('"ref":"k1"');
    expect(previous).toContain('"decision":"accepted"');
    expect(previous).toContain('"execution":"carried out (observed by Reflect)"');
    expect(previous).toContain('"outcome":"the user said it worked"');
    expect(previous).toContain('"userNote":"Got the sync engine merged"');
    expect(previous).toContain('Focus session “Project X” ran 45m of 45m planned, 1 interruption.');

    const report13 = h.repo.getCurrentReport('day', day(13).key)!;
    expect(report13.coach!.followups).toEqual([
      {
        actionId: first.id,
        title: 'Run one 45-minute Focus session on Project X before switching threads',
        note: 'The Focus session ran 45m of the 45m planned, with 1 interruption, and you said it worked.',
        learned: 'A morning block on Project X is realistic for you.',
      },
    ]);

    // ── Wed: the same thing happens again, observed without any link, and it works again.
    const second = h.coachRepo.listActionsByReport(report13.id)[0];
    h.coach.decide(second.id, 'accept');
    h.focusSessions.push(focusSession(14, '09:00', 45));
    h.setNow(local(14, '12:30'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(second.id)).toMatchObject({ status: 'review', execution: 'done', executionSource: 'observed' });
    h.coach.reportOutcome(second.id, 'worked');

    // ── Wed evening: repeated success has become a reusable strategy.
    h.setNow(local(14, '22:05'));
    h.gemini.push(modelDay(day(14), { actions: [], noActionReason: 'The morning block is working; nothing needs changing.' }));
    await h.service.generate(day(14), { trigger: 'scheduled' });
    expect(section(h.gemini.requests[2].prompt, 'WHAT HAS AND HAS NOT WORKED')).toContain(
      'continuing something that worked (up to an hour) in the morning → “Project X”: suggested 1, accepted 1, carried out 1, helped 1.',
    );
    state = h.coach.getState();
    expect(state.recent.map((a) => a.statusLine)).toEqual(['Carried out · it worked', 'Carried out · it worked']);
    expect(state.commitments).toEqual([]);
  });
});

describe('the coach loop — a recommendation that keeps not happening', () => {
  it('adapts after repeated failure, escalates to a question, and learns from the answer', async () => {
    const h = harness(quiet, [13, 14, 15, 16]);
    const generate = async (d: number, ...responses: unknown[]) => {
      h.setNow(local(d, '22:05'));
      h.gemini.push(...responses);
      const result = await h.service.generate(day(d), { trigger: 'scheduled' });
      return { result, report: h.repo.getCurrentReport('day', day(d).key)!, request: h.gemini.requests[h.gemini.requests.length - 1] };
    };
    const acceptLatest = (reportId: string) => {
      const action = h.coachRepo.listActionsByReport(reportId)[0];
      expect(h.coach.decide(action.id, 'accept').ok).toBe(true);
      return action.id;
    };

    // ── Mon: "a 45-minute Focus session on Project X tomorrow morning". Accepted.
    const mon = await generate(12, modelDay(day(12)));
    const a1 = acceptLatest(mon.report.id);

    // ── Tue: nothing matching happens. Reflect reports that — it does not judge.
    h.setNow(local(13, '12:30'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(a1)).toMatchObject({ status: 'review', execution: null, outcome: null });
    expect(h.coach.getState().commitments[0]).toMatchObject({ pending: 'execution', statusLine: 'Not observed — did it happen?' });
    expect(h.coachRepo.getAction(a1)!.observation).toMatchObject({ kind: 'not_observed', facts: ['Nothing matching was observed between Tue, Oct 13, 5:00 AM and 12:00 PM.'] });

    // The user says why.
    h.setNow(local(13, '20:00'));
    expect(h.coach.reportExecution(a1, 'not_done', { reasonCode: 'bad_timing', note: 'Mornings are classes until 11' })).toMatchObject({
      ok: true,
      action: { status: 'closed', statusLine: 'Didn’t happen — bad timing' },
    });

    // ── Tue evening: one miss is not a pattern. The same suggestion is allowed once more.
    const tue = await generate(
      13,
      quietResponse(day(13), {
        followups: [{ actionRef: 'k1', note: 'The morning session did not happen; you said the timing was wrong.', learned: null }],
        actions: [modelAction({ metricKeys: [], actionRefs: ['k1'], rationale: 'Project X received no time today; one more try at the same block before changing it.' })],
      }),
    );
    expect(tue.result).toMatchObject({ status: 'succeeded', attempts: 1 });
    const tuePrevious = section(tue.request.prompt, 'PREVIOUS ACTIONS');
    expect(tuePrevious).toContain('"execution":"not carried out (the user said so)"');
    expect(tuePrevious).toContain('"reason":"bad timing"');
    expect(tuePrevious).toContain('"userNote":"Mornings are classes until 11"');
    const a2 = acceptLatest(tue.report.id);

    // ── Wed: it does not happen again.
    h.setNow(local(14, '20:00'));
    await h.coach.observe();
    h.coach.reportExecution(a2, 'not_done', { reasonCode: 'bad_timing' });

    // ── Wed evening: the record now says this does not work. Repeating it is refused;
    //    the model has to change something real.
    const repeat = quietResponse(day(14), { actions: [modelAction({ metricKeys: [], actionRefs: ['k1'], rationale: 'Project X still needs a block of time.' })] });
    const adapted = quietResponse(day(14), {
      actions: [
        modelAction({
          title: 'Run a 25-minute Focus session on Project X after your afternoon work',
          daypart: 'evening',
          focusMinutes: 25,
          adaptsActionRef: 'k1',
          metricKeys: [],
          rationale: 'The morning block did not happen twice, both times for timing; this moves it later and makes it smaller.',
        }),
      ],
    });
    const wed = await generate(14, repeat, adapted);
    expect(wed.result).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(section(wed.request.prompt, 'WHAT HAS AND HAS NOT WORKED')).toContain(
      'a Focus session (up to an hour) in the morning → “Project X”: suggested 2, accepted 2, carried out 0, helped 0, did not happen 2; reasons given: bad timing ×2. NOT WORKING — do not suggest it again in this form.',
    );
    expect(wed.request.prompt).toContain('action 1: a Focus session (up to an hour) in the morning has not worked out 2 times for this user (bad timing ×2)');
    const a3 = acceptLatest(wed.report.id);
    expect(h.coachRepo.getAction(a3)).toMatchObject({
      strategyKey: 'focus_session|evening|short',
      parentActionId: a2,
      targetStart: iso(15, '17:00'),
      focusMinutes: 25,
    });
    expect(h.coach.getState().next).toEqual([]);
    expect(h.coach.getState().commitments[0].adaptedFrom).toBe('Run one 45-minute Focus session on Project X before switching threads');
    expect(h.coach.getState().learned).toEqual([
      {
        kind: 'does_not_work',
        text: 'A Focus session (up to an hour) in the morning for “Project X” has not worked out 2 times (bad timing ×2), so Reflect will not suggest it that way again.',
      },
    ]);

    // ── Thu: the adapted version does not happen either.
    h.setNow(local(15, '22:01'));
    await h.coach.observe();
    h.coach.reportExecution(a3, 'not_done', { reasonCode: 'external_constraint' });

    // ── Thu evening: three attempts, none worked. The Coach stops advising and asks —
    //    even though the model tried to advise again and forgot to ask.
    const stubborn = quietResponse(day(15), {
      actions: [modelAction({ title: 'Run a 45-minute Focus session on Project X after lunch', daypart: 'afternoon', metricKeys: [], actionRefs: ['k1'], rationale: 'A different time of day may fit better.' })],
      question: null,
    });
    const thu = await generate(15, stubborn, stubborn, stubborn);
    expect(section(thu.request.prompt, 'STOP AND ASK')).toContain('“Project X”: 3 attempts did not work out. Recommend nothing for it. Ask ONE question');
    expect(h.coachRepo.listActionsByReport(thu.report.id)).toEqual([]);
    expect(thu.report.coach!.question).toEqual({
      text: '3 suggestions about “Project X” have not worked out. Before suggesting another one, what keeps getting in the way?',
      actionId: a3,
      targetKey: 't:project-x',
    });
    let state = h.coach.getState();
    expect(state.question).toMatchObject({ text: thu.report.coach!.question!.text, actionId: a3 });
    expect(state.messages.at(-1)).toMatchObject({ role: 'coach', meta: { kind: 'question', targetKey: 't:project-x' } });

    // ── The user answers in the conversation. Their words become durable memory.
    h.setNow(local(16, '08:30'));
    h.gemini.push(
      modelChat({
        reply: 'Understood. Weekday mornings and evenings are taken; weekends are where there is room.',
        memoryUpdates: [{ op: 'add', kind: 'constraint', text: 'Weekday mornings are classes until 11 and evenings are practice; weekends are free.', memoryRef: null }],
      }),
    );
    const chat = await h.coach.chat('Weekday mornings are classes until 11 and evenings I am at practice. Weekends are free though.');
    expect(chat.ok).toBe(true);
    const chatPrompt = h.gemini.requests[h.gemini.requests.length - 1].prompt;
    expect(chatPrompt).toContain('PENDING QUESTION (the Coach asked this and is waiting for the answer)');
    expect(chatPrompt).toContain('NOT WORKING — do not suggest it again in this form.');

    state = h.coach.getState();
    expect(state.question).toBeNull();
    expect(h.coachRepo.memories).toMatchObject([
      {
        kind: 'constraint',
        source: 'user',
        status: 'active',
        text: 'Weekday mornings are classes until 11 and evenings are practice; weekends are free.',
        // What was said in answer to a question is about what was asked.
        targetKey: 't:project-x',
      },
    ]);

    // ── Fri evening: no more "stop and ask". The next recommendation is built on what
    //    the user said — a different kind of intervention, not the fourth time slot.
    const fri = await generate(
      16,
      quietResponse(day(16), {
        actions: [
          modelAction({
            title: 'Keep one weekend block for Project X',
            actionType: 'protect_priority',
            when: 'this_week',
            daypart: 'any',
            focusMinutes: null,
            focusTask: null,
            metricKeys: [],
            actionRefs: ['k1'],
            rationale: 'Weekday blocks did not happen; you said weekends are free.',
          }),
        ],
      }),
    );
    expect(fri.result).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(fri.request.prompt).not.toContain('STOP AND ASK');
    expect(section(fri.request.prompt, 'COACH MEMORY')).toContain('"text":"Weekday mornings are classes until 11 and evenings are practice; weekends are free."');
    expect(h.coachRepo.listActionsByReport(fri.report.id)[0]).toMatchObject({
      actionType: 'protect_priority',
      strategyKey: 'protect_priority|any|none',
      targetStart: iso(17),
      targetEnd: iso(24),
    });
    // The question is not asked a second time.
    expect(fri.report.coach!.question).toBeNull();
    expect(h.coachRepo.messages.filter((m) => m.meta?.kind === 'question')).toHaveLength(1);
  });
});

describe('the coach loop — what the user turned down stays turned down', () => {
  it('a rejected suggestion is shown to the model as rejected and refused if it comes back', async () => {
    const h = harness(quiet, [13]);
    h.gemini.push(modelDay(day(12)));
    await h.service.generate(day(12), { trigger: 'scheduled' });
    const suggestion = h.coachRepo.actions[0];

    h.setNow(local(12, '22:10'));
    expect(h.coach.decide(suggestion.id, 'reject', { reasonCode: 'not_relevant', note: 'Project X is on hold this month' })).toMatchObject({
      ok: true,
      action: { status: 'rejected', statusLine: 'Rejected — not relevant' },
    });
    expect(h.coach.getState()).toMatchObject({ next: [], commitments: [] });

    h.setNow(local(13, '22:05'));
    const again = quietResponse(day(13), {
      actions: [modelAction({ title: 'Protect the first hour of tomorrow for Project X', actionType: 'protect_priority', focusMinutes: null, focusTask: null, metricKeys: ['thread.project-y.minutes'], rationale: 'Project X received no time today.' })],
    });
    h.gemini.push(again, again, again);
    await h.service.generate(day(13), { trigger: 'scheduled' });

    const { prompt } = h.gemini.requests[1];
    expect(section(prompt, 'REJECTED BY THE USER')).toContain(
      '- Run one 45-minute Focus session on Project X before switching threads — not relevant (“Project X is on hold this month”)',
    );
    // Rejections are not followed up either.
    expect(section(prompt, 'PREVIOUS ACTIONS')).toBe('PREVIOUS ACTIONS\nNone to follow up.');
    expect(h.gemini.requests[2].prompt).toContain('action 1: the user rejected this');
    expect(h.coachRepo.actions.filter((a) => a.status === 'suggested')).toEqual([]);
  });
});

describe('the coach loop — an open commitment', () => {
  it('follows up an accepted commitment whose time has not come, without treating it as anything yet', async () => {
    const h = harness(quiet, [13]);
    h.gemini.push(modelDay(day(12), { actions: [modelAction({ when: 'this_week', daypart: 'any', actionType: 'protect_priority', focusMinutes: null, focusTask: null, title: 'Protect one block for Project X this week' })] }));
    await h.service.generate(day(12), { trigger: 'scheduled' });
    const action = h.coachRepo.actions[0];
    h.coach.decide(action.id, 'accept');

    h.setNow(local(13, '22:05'));
    h.gemini.push(quietResponse(day(13), { actions: [], noActionReason: 'Your open commitment for this week still stands.' }));
    await h.service.generate(day(13), { trigger: 'scheduled' });

    const previous = section(h.gemini.requests[1].prompt, 'PREVIOUS ACTIONS');
    expect(previous).toContain('"target":"This week"');
    expect(previous).toContain('"execution":"still open"');
    expect(h.coachRepo.getAction(action.id)!.status).toBe('accepted');
  });
});
