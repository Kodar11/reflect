import { describe, it, expect } from 'vitest';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import { browsing, focusSession, iso, local, makeReflectionHarness, projectX, projectY, seedThreads, workday, type HarnessOptions } from '../reflection/helpers';
import { accepted, coachAction, memory, message, modelAction, modelChat, notDone, worked } from './helpers';

/**
 * The Coach service on its own: user decisions, the observation sweep, the
 * read model, memory, settings and the conversation. "Now" is Tue Oct 13.
 */
function harness(options: HarnessOptions = {}) {
  const h = makeReflectionHarness({
    activities: [...[5, 6, 7, 8, 9, 12].flatMap(workday), projectY(13, '09:00', 60), browsing(13, '10:30', 30)],
    now: local(13, '08:00'),
    priorities: ['Launching Project X'],
    coach: true,
    ...options,
  });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0].id });
  return { ...h, priorityId: priorities[0].id };
}

describe('CoachService — the user decides', () => {
  it('accept / not now / reject, each recorded in the audit trail', () => {
    const h = harness();
    const [a, b, c] = [coachAction(), coachAction({ title: 'Close the billing loop', thread: 'Project Y' }), coachAction({ title: 'Rest tonight', actionType: 'rest', thread: null })];
    h.coachRepo.actions.push(a, b, c);

    expect(h.coach.decide(a.id, 'accept')).toMatchObject({ ok: true, action: { status: 'accepted' } });
    expect(h.coach.decide(b.id, 'not_now')).toMatchObject({ ok: true, action: { status: 'snoozed', statusLine: 'Not now — Reflect will ask once more' } });
    expect(h.coach.decide(c.id, 'reject', { reasonCode: 'different_priority', note: '  Exam week  ' })).toMatchObject({
      ok: true,
      action: { status: 'rejected', reasonCode: 'different_priority', note: 'Exam week' },
    });

    expect(h.coachRepo.getAction(b.id)!.snoozedUntil).toBe(iso(14)); // the start of the user's next day
    expect(h.coachRepo.events.map((e) => [e.type, e.fromStatus, e.toStatus])).toEqual([
      ['accept', 'suggested', 'accepted'],
      ['snooze', 'suggested', 'snoozed'],
      ['reject', 'suggested', 'rejected'],
    ]);
    expect(h.coachChanges.count).toBeGreaterThanOrEqual(3);
  });

  it('never throws: an unknown action or an impossible step is a result', () => {
    const h = harness();
    const rejected = coachAction({ status: 'rejected' });
    h.coachRepo.actions.push(rejected);
    expect(h.coach.decide('nope', 'accept')).toEqual({ ok: false, error: 'That action no longer exists.' });
    expect(h.coach.decide(rejected.id, 'accept')).toEqual({ ok: false, error: 'A rejected action cannot accept.' });
    expect(h.coach.reportOutcome(rejected.id, 'worked')).toMatchObject({ ok: false });
    expect(h.coach.reportOutcome(rejected.id, 'great' as never)).toEqual({ ok: false, error: 'Unknown answer.' });
    expect(h.coachRepo.getAction(rejected.id)).toEqual(rejected);
  });

  it('keeps the user\'s reason — but never health or personal details', () => {
    const h = harness();
    const a = accepted();
    h.coachRepo.actions.push(a);
    const result = h.coach.reportExecution(a.id, 'not_done', { reasonCode: 'external_constraint', note: 'Had a migraine all morning' });
    expect(result).toMatchObject({ ok: true, noteDropped: true, action: { status: 'closed', reasonCode: 'external_constraint', note: null } });
    expect(JSON.stringify(h.coachRepo.actions)).not.toContain('migraine');
    expect(JSON.stringify(h.coachRepo.events)).not.toContain('migraine');
  });

  it('editing changes the action and what kind of strategy it is', () => {
    const h = harness({ now: local(12, '22:10') });
    const a = coachAction();
    h.coachRepo.actions.push(a);

    const result = h.coach.edit(a.id, { title: '  A short Project X block after lunch  ', focusMinutes: 25, daypart: 'afternoon' });
    expect(result).toMatchObject({ ok: true, action: { title: 'A short Project X block after lunch', focusMinutes: 25, targetLabel: 'Tomorrow · afternoon' } });
    expect(h.coachRepo.getAction(a.id)).toMatchObject({
      userEdited: true,
      strategyKey: 'focus_session|afternoon|short',
      targetStart: iso(13, '12:00'),
      targetEnd: iso(13, '17:00'),
    });

    // Moving it to today, and clamping a silly length.
    h.setNow(local(13, '08:00'));
    h.coach.edit(a.id, { when: 'today', daypart: 'evening', focusMinutes: 9999 });
    expect(h.coachRepo.getAction(a.id)).toMatchObject({ targetStart: iso(13, '17:00'), focusMinutes: 180, strategyKey: 'focus_session|evening|long' });
  });
});

describe('CoachService — the observation sweep', () => {
  it('uses Reflect\'s own data: a matching Focus session settles an accepted action without self-report', async () => {
    const h = harness();
    const a = accepted();
    h.coachRepo.actions.push(a);
    h.focusSessions.push(focusSession(13, '09:00', 45));

    h.setNow(local(13, '10:00'));
    expect(await h.coach.observe()).toBe(1);
    expect(h.coachRepo.getAction(a.id)).toMatchObject({ status: 'review', execution: 'done', executionSource: 'observed', executedAt: iso(13, '09:45') });
    // A second sweep finds nothing new.
    expect(await h.coach.observe()).toBe(0);
  });

  it('detects work on the target that did not go through Focus', async () => {
    const h = harness();
    const a = accepted();
    h.coachRepo.actions.push(a);
    h.activities.push(projectX(13, '11:00', 50));
    h.metrics.invalidate();

    h.setNow(local(13, '12:30'));
    await h.coach.observe();
    const action = h.coachRepo.getAction(a.id)!;
    expect(action).toMatchObject({ status: 'review', execution: 'partial', executionSource: 'observed' });
    expect(action.observation).toMatchObject({ kind: 'attempted', matchedMinutes: 50 });
  });

  it('asks instead of guessing when the evidence is ambiguous', async () => {
    const h = harness();
    const a = accepted();
    h.coachRepo.actions.push(a);
    h.focusSessions.push(focusSession(13, '09:00', 45, { task: 'Fix Project Y billing bug' }));

    h.setNow(local(13, '12:30'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(a.id)).toMatchObject({ status: 'review', execution: null, outcome: null });
    expect(h.coach.getState().commitments[0]).toMatchObject({ pending: 'execution', statusLine: 'Reflect can’t tell whether this happened — did it?' });
  });

  it('does nothing before the window, and waits while the window is open', async () => {
    const h = harness({ now: local(12, '23:00') });
    const a = accepted();
    h.coachRepo.actions.push(a);
    expect(await h.coach.observe()).toBe(0);
    h.setNow(local(13, '08:00'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(a.id)!.status).toBe('accepted');
  });

  it('an undecided suggestion expires when its moment has passed', async () => {
    const h = harness();
    const a = coachAction();
    h.coachRepo.actions.push(a);
    h.setNow(local(13, '12:30'));
    expect(await h.coach.observe()).toBe(1);
    expect(h.coachRepo.getAction(a.id)).toMatchObject({ status: 'expired', rejectedAt: null });
    expect(h.coach.getState().next).toEqual([]);
  });

  it('"Not now" comes back once, a day later — and not at all after a long absence', async () => {
    const h = harness({ now: local(12, '22:10') });
    const [soon, stale] = [coachAction(), coachAction({ title: 'Close the billing loop', thread: 'Project Y' })];
    h.coachRepo.actions.push(soon, stale);
    h.coach.decide(soon.id, 'not_now');
    h.coach.decide(stale.id, 'not_now');
    expect(h.coach.getState().next).toEqual([]);

    h.setNow(local(13, '08:00'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(soon.id)).toMatchObject({ status: 'suggested', targetStart: iso(14, '05:00'), targetEnd: iso(14, '12:00'), snoozeCount: 1 });
    expect(h.coach.getState().next.map((a) => a.id)).toContain(soon.id);

    // Asked again, "Not now" is taken as an answer about timing.
    expect(h.coach.decide(soon.id, 'not_now')).toMatchObject({ ok: true, action: { status: 'expired', reasonCode: 'bad_timing' } });

    const away = harness({ now: local(12, '22:10') });
    const old = coachAction();
    away.coachRepo.actions.push(old);
    away.coach.decide(old.id, 'not_now');
    away.setNow(local(18, '09:00'));
    await away.coach.observe();
    expect(away.coachRepo.getAction(old.id)!.status).toBe('expired');
  });

  it('closes a review nobody answered, without inventing an outcome', async () => {
    const h = harness();
    const a = accepted();
    h.coachRepo.actions.push(a);
    h.setNow(local(13, '12:30'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(a.id)!.status).toBe('review');

    h.setNow(local(19, '09:00'));
    await h.coach.observe();
    expect(h.coachRepo.getAction(a.id)).toMatchObject({ status: 'closed', execution: null, outcome: null });
    expect(h.coach.getState().recent[0].statusLine).toBe('Not observed');
  });

  it('starting Focus from a suggestion is a commitment; with nothing running it is refused', () => {
    const h = harness();
    const a = coachAction();
    h.coachRepo.actions.push(a);
    expect(h.coach.linkFocus(a.id)).toMatchObject({ ok: false });

    h.focusSessions.push(focusSession(13, '08:00', 45, { state: 'active', endedAt: null, endReason: null }));
    expect(h.coach.linkFocus(a.id)).toMatchObject({ ok: true, action: { status: 'accepted', canStartFocus: false } });
  });
});

describe('CoachService — the read model', () => {
  it('groups actions by what the user needs to do about them', () => {
    const h = harness();
    const review = accepted({ status: 'review', execution: 'done', executionSource: 'observed', title: 'Review me' });
    h.coachRepo.actions.push(
      coachAction({ title: 'Decide me', reportId: 'report-12' }),
      accepted({ title: 'Committed' }),
      review,
      worked(10, { title: 'Settled well' }),
      coachAction({ status: 'withdrawn', title: 'Replaced' }),
      coachAction({ status: 'expired', title: 'Ignored' }),
    );
    h.coachRepo.memories.push(memory('Mornings are classes until 11.'));
    h.coachRepo.messages.push(message('coach', 'What keeps getting in the way?', iso(12, '22:05'), { kind: 'question', aboutActionId: review.id }));

    const state = h.coach.getState('report-12');
    expect(state.configured).toBe(true);
    expect(state.next.map((a) => a.title)).toEqual(['Decide me']);
    // What is waiting for the user's word comes first.
    expect(state.commitments.map((a) => [a.title, a.pending])).toEqual([['Review me', 'outcome'], ['Committed', null]]);
    expect(state.recent.map((a) => a.title)).toEqual(['Settled well']);
    expect(state.reportActions.map((a) => a.title)).not.toContain('Replaced');
    expect(state.memory).toMatchObject([{ kind: 'constraint', text: 'Mornings are classes until 11.', source: 'user' }]);
    expect(state.question).toMatchObject({ text: 'What keeps getting in the way?', actionId: review.id });
  });

  it('never throws and never calls Gemini', () => {
    const h = harness();
    h.coachRepo.listActions = () => {
      throw new Error('db locked');
    };
    expect(h.coach.getState()).toMatchObject({ next: [], commitments: [], recent: [], memory: [], question: null });
    expect(h.gemini.requests).toEqual([]);
  });

  it('lets the user see and remove what Reflect remembers', () => {
    const h = harness();
    const m = memory('Mornings are classes until 11.');
    h.coachRepo.memories.push(m);
    expect(h.coach.removeMemory(m.id)).toBe(true);
    expect(h.coach.getState().memory).toEqual([]);
    expect(h.coach.removeMemory(m.id)).toBe(false);
  });

  it('stores normalized settings', () => {
    const h = harness();
    expect(h.coach.getSettings()).toEqual({ reflectionMinutes: 1320, dayStartMinutes: 0, notifyDailyReflection: true });
    expect(h.coach.saveSettings({ reflectionMinutes: 21 * 60 + 30, dayStartMinutes: 600, notifyDailyReflection: 'yes' })).toEqual({
      reflectionMinutes: 1290,
      dayStartMinutes: 360, // a day may start at 6 AM at the latest
      notifyDailyReflection: true,
    });
    expect(h.coach.saveSettings({ dayStartMinutes: 240 })).toMatchObject({ reflectionMinutes: 1290, dayStartMinutes: 240 });
    expect(h.coach.saveSettings('garbage')).toMatchObject({ reflectionMinutes: 1290, dayStartMinutes: 240 });
  });
});

describe('CoachService — conversation', () => {
  it('answers from the structured record, and stores both sides of the turn', async () => {
    const h = harness();
    h.coachRepo.actions.push(worked(9), worked(11), notDone(10, { daypart: 'evening', strategyKey: 'focus_session|evening|medium' }));
    h.coachRepo.memories.push(memory('Mornings before 11 are usually free on Tuesdays.', { kind: 'preference' }));
    h.gemini.push(modelChat({ reply: 'A morning Focus block on Project X has helped 2 of 2 times; the evening one did not happen.' }));

    const result = await h.coach.chat('  What has actually worked for Project X?  ');
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'What has actually worked for Project X?'],
      ['coach', 'A morning Focus block on Project X has helped 2 of 2 times; the evening one did not happen.'],
    ]);
    expect(h.coachRepo.messages).toHaveLength(2);

    const { prompt, systemInstruction } = h.gemini.requests[0];
    expect(systemInstruction).toContain('You are the same coach that writes their daily reflection');
    expect(prompt).toContain('In their words: I build Project X.');
    expect(prompt).toContain(`{"id":"${h.priorityId}","text":"Launching Project X","possiblyStale":false}`);
    expect(prompt).toContain('TODAY SO FAR (measured by Reflect)');
    expect(prompt).toContain('RECENT DAYS (measured by Reflect)');
    expect(prompt).toContain('Mon, Oct 12: tracked 4h 32m');
    expect(prompt).toContain('ACTIONS (the record of what was suggested, decided, observed and said; refer to one by its ref)');
    expect(prompt).toContain('a Focus session (up to an hour) in the morning → “Project X”: suggested 2, accepted 2, carried out 2, helped 2. WORKS for this user');
    expect(prompt).toContain('"text":"Mornings before 11 are usually free on Tuesdays."');
    expect(prompt).toContain("THE USER'S MESSAGE\nWhat has actually worked for Project X?");
    expect(prompt).not.toMatch(/eventIds|payload|watcher/);
  });

  it('includes what Reflect already told the user, and the earlier turns', async () => {
    const h = harness({ now: local(12, '22:05') });
    const { periodContaining } = await import('../../src/reflection/ReflectionPeriods');
    const { modelDay } = await import('./helpers');
    h.gemini.push(modelDay(periodContaining('day', local(12)), { actions: [] }));
    await h.service.generate(periodContaining('day', local(12)), { trigger: 'scheduled' });

    h.setNow(local(13, '08:00'));
    h.gemini.push(modelChat({ reply: 'Yesterday Project X took your morning.' }), modelChat({ reply: 'The afternoon moved between threads.' }));
    await h.coach.chat('How was yesterday?');
    await h.coach.chat('And the afternoon?');

    const second = h.gemini.requests[2].prompt;
    expect(second).toContain('LATEST REFLECTIONS (what Reflect already told the user)');
    expect(second).toContain('Mon, Oct 12: Project X took your morning; the afternoon moved between threads.');
    expect(second).toContain('CONVERSATION SO FAR\nUser: How was yesterday?\nCoach: Yesterday Project X took your morning.');
  });

  it('applies what the user says happened through the same lifecycle, and shows what changed', async () => {
    const h = harness({ now: local(13, '20:00') });
    const a = accepted();
    h.coachRepo.actions.push(a);
    h.gemini.push(
      modelChat({
        reply: 'Noted — I have recorded that you did it and that it helped.',
        actionUpdates: [
          { actionRef: 'k1', update: 'done', reasonCode: null, note: null },
          { actionRef: 'k1', update: 'worked', reasonCode: null, note: 'Finished the sync engine' },
        ],
      }),
    );

    const result = await h.coach.chat('I actually did the Project X session this morning, off the laptop. It worked, I finished the sync engine.');
    expect(result.ok).toBe(true);
    expect(h.coachRepo.getAction(a.id)).toMatchObject({ status: 'closed', execution: 'done', executionSource: 'user', outcome: 'worked', note: 'Finished the sync engine' });
    expect(h.coachRepo.messages[1].meta).toMatchObject({
      kind: 'reply',
      actions: [
        { actionId: a.id, change: 'marked as done' },
        { actionId: a.id, change: 'recorded as having worked' },
      ],
    });
    // The sweep before the turn had already noted "not observed"; the user's word then settled it.
    expect(h.coachRepo.events.map((e) => [e.type, e.detail?.via ?? 'observation'])).toEqual([
      ['observe', 'observation'],
      ['execution', 'conversation'],
      ['outcome', 'conversation'],
    ]);
  });

  it('turns something the user commits to into a tracked action', async () => {
    const h = harness({ now: local(13, '20:00') });
    h.gemini.push(modelChat({ reply: 'Added: a 30-minute Project X session tomorrow morning.', proposedAction: { ...modelAction({ focusMinutes: 30, title: 'Run a 30-minute Focus session on Project X', metricKeys: [] }), committed: true } }));

    await h.coach.chat('Tomorrow morning I will do 30 minutes on Project X.');
    expect(h.coachRepo.actions).toMatchObject([
      { source: 'conversation', reportId: null, status: 'accepted', focusMinutes: 30, targetStart: iso(14, '05:00'), originDayKey: '2026-10-13' },
    ]);
    expect(h.coach.getState().commitments[0]).toMatchObject({ title: 'Run a 30-minute Focus session on Project X', targetLabel: 'Tomorrow · morning' });
  });

  it('a suggestion made in conversation still waits for the user\'s decision', async () => {
    const h = harness({ now: local(13, '20:00') });
    h.gemini.push(modelChat({ reply: 'One option is a short block tomorrow morning.', proposedAction: { ...modelAction({ metricKeys: [] }), committed: false } }));
    await h.coach.chat('What should I focus on tomorrow?');
    expect(h.coach.getState().next).toMatchObject([{ source: 'conversation', status: 'suggested', pending: 'decision' }]);
  });

  it('routes "that wasn\'t what I was doing" to the Timeline correction flow', async () => {
    const h = harness({ now: local(13, '12:00') });
    h.gemini.push(modelChat({ reply: 'You can correct that block in the Timeline; the next reflection will use your correction.', correctionActivityRef: 'a1' }));
    const result = await h.coach.chat('The 9 AM block was not Project Y, I was reviewing a friend\'s code.');
    expect(result.ok && result.messages[1].meta?.correction).toMatchObject({ title: 'Fix Project Y billing bug', start: iso(13, '09:00') });
    // Nothing about the activity itself is changed by the Coach.
    expect(h.activities.find((a) => a.startedAt === iso(13, '09:00'))!.title).toBe('Fix Project Y billing bug');
  });

  it('retries once when the reply is not grounded, then answers', async () => {
    const h = harness();
    h.gemini.push(modelChat({ reply: 'You were 73% more focused than usual.' }), modelChat({ reply: 'I do not have a comparison for that yet.' }));
    const result = await h.coach.chat('Was I more focused today?');
    expect(result).toMatchObject({ ok: true });
    expect(h.gemini.requests[1].prompt).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED');
    expect(h.gemini.requests[1].prompt).toContain('number(s) "73" are not in the context');
    expect(h.coachRepo.messages.map((m) => m.text)).toEqual(['Was I more focused today?', 'I do not have a comparison for that yet.']);
  });

  it('gives no answer rather than an ungrounded one — and writes nothing', async () => {
    const h = harness();
    const a = accepted();
    h.coachRepo.actions.push(a);
    const bad = modelChat({ reply: 'You wasted 3 hours procrastinating.', actionUpdates: [{ actionRef: 'k1', update: 'not_done', reasonCode: null, note: null }] });
    h.gemini.push(bad, bad);

    const result = await h.coach.chat('How did I do?');
    expect(result).toEqual({
      ok: false,
      category: 'validation',
      message: 'The Coach could not give an answer it could back up from your record, so it gave none. Try asking it another way.',
    });
    expect(h.coachRepo.messages).toEqual([]);
    expect(h.coachRepo.getAction(a.id)!.status).toBe('accepted');
    expect(h.coachRepo.memories).toEqual([]);
  });

  it('keeps a grounded reply even when a side-effect it proposed was refused', async () => {
    const h = harness();
    const suggested = coachAction();
    h.coachRepo.actions.push(suggested);
    const response = modelChat({ reply: 'That suggestion is still waiting for your decision.', actionUpdates: [{ actionRef: 'k1', update: 'worked', reasonCode: null, note: null }] });
    h.gemini.push(response, response);

    const result = await h.coach.chat('Did the Project X thing work?');
    expect(result).toMatchObject({ ok: true });
    expect(h.coachRepo.getAction(suggested.id)!.status).toBe('suggested'); // no invented outcome
    expect(h.coachRepo.messages[1]).toMatchObject({ text: 'That suggestion is still waiting for your decision.', meta: { actions: [] } });
  });

  it('fails safely when Gemini is unavailable', async () => {
    const offline = harness();
    const down = new GeminiError('network', 'Gemini network error: offline', true);
    offline.gemini.push(down, down);
    expect(await offline.coach.chat('What should I focus on tomorrow?')).toMatchObject({ ok: false, category: 'network' });
    expect(offline.coachRepo.messages).toEqual([]);

    const quota = harness();
    quota.gemini.push(new GeminiError('quota', 'Gemini quota/rate limit (429)', true, 429), '{not json');
    expect(await quota.coach.chat('What should I focus on tomorrow?')).toMatchObject({ ok: false });

    const noKey = harness();
    noKey.gemini.configured = false;
    expect(await noKey.coach.chat('Hello?')).toMatchObject({ ok: false, category: 'not_configured' });
    expect(noKey.gemini.requests).toEqual([]);
    expect(noKey.coach.getState().configured).toBe(false);

    expect(await harness().coach.chat('   ')).toMatchObject({ ok: false, category: 'empty' });
  });

  it('answers turns in order, one at a time', async () => {
    const h = harness();
    h.gemini.push(modelChat({ reply: 'First answer.' }), modelChat({ reply: 'Second answer.' }));
    const [first, second] = await Promise.all([h.coach.chat('First question?'), h.coach.chat('Second question?')]);
    expect(first.ok && second.ok).toBe(true);
    expect(h.coachRepo.messages.map((m) => m.text)).toEqual(['First question?', 'First answer.', 'Second question?', 'Second answer.']);
  });
});
