import { describe, it, expect } from 'vitest';
import { COACH_PROMPT_VERSION } from '../../src/coach/CoachPrompt';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import {
  browsing,
  iso,
  local,
  makeReflectionHarness,
  modelInsight,
  modelReflection,
  projectX,
  projectY,
  research,
  seedThreads,
  workday,
  type HarnessOptions,
} from '../reflection/helpers';
import { modelAction, modelDay } from './helpers';

/**
 * The unified daily pass: ONE Gemini request produces the day's reflection
 * and its coaching, and one transaction stores the report, its actions and
 * its memory. Scripted Gemini; real pipeline, validator and coach service.
 *
 * History: a working week (Mon Oct 5 – Fri Oct 9), then Mon Oct 12. "Now" is
 * Mon Oct 12, 10:05 PM — the end of the user's day.
 */
const history = () => [5, 6, 7, 8, 9, 12].flatMap(workday);
const day12 = periodContaining('day', local(12));

function harness(options: HarnessOptions = {}) {
  const h = makeReflectionHarness({
    activities: history(),
    now: local(12, '22:05'),
    priorities: ['Launching Project X'],
    coach: true,
    ...options,
  });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0]?.id ?? 'none' });
  return { ...h, priorityId: priorities[0]?.id as string };
}

const secondAction = (overrides: Record<string, unknown> = {}) =>
  modelAction({
    title: 'Decide whether the Project Y billing fix is finished or dropped',
    actionType: 'close_open_loop',
    daypart: 'any',
    focusMinutes: null,
    focusTask: null,
    thread: 'Project Y',
    metricKeys: ['thread.project-y.minutes'],
    rationale: 'Project Y was picked up twice between other threads and left again.',
    ...overrides,
  });

describe('daily intelligence — one request, one transaction', () => {
  it('writes the reflection and the coaching together, and stores recommendations as tracked actions', async () => {
    const h = harness();
    h.gemini.push(modelDay(day12));

    const result = await h.service.generate(day12, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 1, insightCount: 1 });
    expect(h.gemini.requests).toHaveLength(1); // not one call for reflection and another for advice

    const report = h.repo.getCurrentReport('day', day12.key)!;
    expect(report).toMatchObject({
      status: 'fresh',
      headline: 'Project X took your morning; the afternoon moved between threads.',
      narrative: 'You started with a long stretch on Project X. After lunch the day broke into shorter pieces across Project Y, research and video.',
      // What to do next is a tracked action now, not a sentence.
      carryForward: null,
    });

    const [action] = h.coachRepo.actions;
    expect(h.coachRepo.actions).toHaveLength(1);
    expect(action).toMatchObject({
      source: 'daily',
      reportId: report.id,
      originDayKey: '2026-10-12',
      status: 'suggested',
      title: 'Run one 45-minute Focus session on Project X before switching threads',
      actionType: 'focus_session',
      targetStart: iso(13, '05:00'),
      targetEnd: iso(13, '12:00'),
      focusMinutes: 45,
      strategyKey: 'focus_session|morning|medium',
      targetKey: 't:project-x',
      execution: null,
      outcome: null,
    });
    // Canonical ids are the backend's; the model never supplies one.
    expect(action.id).toMatch(/^c-\d+$/);
    expect(report.coach).toMatchObject({ actionIds: [action.id], followups: [], noActionReason: null, question: null });
    // Every recommendation is traceable to deterministic evidence.
    expect(action.evidence[0]).toMatchObject({ kind: 'metric', metricKey: 'thread.project-x.minutes' });
    expect(h.coachRepo.events).toMatchObject([{ actionId: action.id, type: 'suggested', fromStatus: null, toStatus: 'suggested' }]);
  });

  it('sends a compact, structured context — the coach reads the record, not the database', async () => {
    const h = harness();
    h.gemini.push(modelDay(day12));
    await h.service.generate(day12, { trigger: 'scheduled' });

    const { prompt, systemInstruction, responseJsonSchema } = h.gemini.requests[0];
    expect(systemInstruction).toContain('You are Reflect, a personal activity reflection system.');
    expect(systemInstruction).toContain('THE COACH');
    expect(systemInstruction).toContain('"No useful advice today" is a complete and good answer');
    expect(systemInstruction).toContain('WHOSE WORD COUNTS');
    // The single carry-forward gives way to tracked actions.
    expect(systemInstruction).toContain('Use null. What to do next belongs in the "coach" part');

    expect(prompt).toContain('COACH CONTEXT');
    expect(prompt).toContain('PREVIOUS ACTIONS\nNone to follow up.');
    expect(prompt).toContain('WHAT HAS AND HAS NOT WORKED FOR THIS USER\nNo outcomes yet. Start small.');
    expect(prompt).toContain('COACH MEMORY\nEmpty.');
    expect(prompt).toContain('At most 2 actions; zero is a good answer');
    expect(prompt).toContain('The day is still running: "today" means what is left of it.');
    // Today in detail; earlier days as citable, deterministic measurements.
    expect(prompt).toContain('{"key":"recent.2026-10-09.tracked_minutes","label":"Tracked time — Fri, Oct 9","value":"4h 32m"}');
    expect(prompt).toContain(`"key":"recent.priority.${h.priorityId}.active_days"`);
    expect(prompt).not.toMatch(/eventIds|payload|watcher/);

    const schema = responseJsonSchema as { required: string[]; properties: { coach: { properties: Record<string, unknown> } } };
    expect(schema.required).toContain('coach');
    expect(Object.keys(schema.properties.coach.properties)).toEqual(['followups', 'actions', 'noActionReason', 'question', 'uncertainty', 'memoryUpdates']);
    expect(COACH_PROMPT_VERSION).toBe('reflect-coach-v1');
  });

  it('explicitly supports "no useful advice today"', async () => {
    const h = harness();
    h.gemini.push(modelDay(day12, { actions: [], noActionReason: 'Your time went where you said it matters; nothing needs changing.' }));
    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(h.coachRepo.actions).toEqual([]);
    expect(h.repo.getCurrentReport('day', day12.key)!.coach).toMatchObject({
      actionIds: [],
      noActionReason: 'Your time went where you said it matters; nothing needs changing.',
    });
  });

  it('stores two actions, and never more than two', async () => {
    const two = harness();
    two.gemini.push(modelDay(day12, { actions: [modelAction(), secondAction()] }));
    await two.service.generate(day12, { trigger: 'scheduled' });
    expect(two.coachRepo.actions.map((a) => a.actionType)).toEqual(['focus_session', 'close_open_loop']);

    const three = harness();
    const extra = secondAction({ title: 'Keep the research reading for the evening', actionType: 'change_timing', daypart: 'evening', thread: 'Research', metricKeys: ['thread.research.minutes'], confidence: 0.5 });
    const tooMany = modelDay(day12, { actions: [modelAction(), secondAction(), extra] });
    three.gemini.push(tooMany, tooMany, tooMany);
    const result = await three.service.generate(day12, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(three.gemini.requests[1].prompt).toContain('too many actions: 3 returned, at most 2 allowed');
    expect(three.coachRepo.actions).toHaveLength(2);
  });

  it('keeps what the user was told about earlier days out of the coaching of a day long past', async () => {
    // Fri Oct 9 is reflected on three days later: a tip about "tomorrow" would be meaningless.
    const h = harness();
    const day9 = periodContaining('day', local(9));
    h.gemini.push(modelReflection(day9, { carryForward: { text: 'Keep a morning block for Project X.', sourceMetricKeys: ['thread.project-x.minutes'], sourceActivityRefs: [] } }));
    await h.service.generate(day9, { trigger: 'scheduled' });

    expect(h.gemini.requests[0].systemInstruction).not.toContain('THE COACH');
    expect(h.gemini.requests[0].prompt).not.toContain('COACH CONTEXT');
    expect(h.repo.getCurrentReport('day', day9.key)).toMatchObject({ coach: null, carryForward: { text: 'Keep a morning block for Project X.' } });
    expect(h.coachRepo.actions).toEqual([]);
  });

  it('a week is reflected on without coaching, exactly as before', async () => {
    const h = harness({ now: local(19, '09:00') });
    const week41 = periodContaining('week', local(7));
    h.gemini.push(modelReflection(week41));
    await h.service.generate(week41, { trigger: 'scheduled' });
    expect(h.gemini.requests[0].systemInstruction).not.toContain('THE COACH');
    expect(h.repo.getCurrentReport('week', week41.key)!.coach).toBeNull();
  });
});

describe('daily intelligence — evidence precedence', () => {
  it('shows the model which activities the user corrected, and tells it whose word counts', async () => {
    const corrected = projectX(12, '16:00', 40, { title: 'Client call about Project X pricing', source: 'user_override', note: 'This was the pricing call, not coding' });
    const h = harness({ activities: [...history(), corrected] });
    h.gemini.push(modelDay(day12));
    await h.service.generate(day12, { trigger: 'scheduled' });

    const { prompt, systemInstruction } = h.gemini.requests[0];
    expect(prompt).toContain('"title":"Client call about Project X pricing"');
    expect(prompt).toContain('"source":"user_override","note":"This was the pricing call, not coding"');
    expect(systemInstruction).toContain('1. What the user corrected or ruled explicitly: an activity with source "user_override"');
    expect(systemInstruction).toContain('Never let a lower level contradict a higher one.');
  });
});

describe('daily intelligence — invalid output never corrupts anything', () => {
  it('retries with the coach\'s problems as feedback, alongside the reflection\'s', async () => {
    const h = harness();
    const bad = modelDay(day12, { actions: [modelAction({ metricKeys: ['thread.made-up.minutes'], rationale: 'You switched 99 times before noon.' })] });
    h.gemini.push(bad, modelDay(day12));

    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.gemini.requests[1].prompt).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED');
    expect(h.gemini.requests[1].prompt).toContain('action 1: metric "thread.made-up.minutes" does not exist');
    expect(h.coachRepo.actions).toHaveLength(1);
  });

  it('after exhausting retries, keeps the reflection and only the coaching that validated', async () => {
    const h = harness();
    const bad = () =>
      modelDay(day12, {
        actions: [modelAction({ metricKeys: ['thread.made-up.minutes'] }), secondAction()],
      });
    h.gemini.push(bad(), bad(), bad());

    const result = await h.service.generate(day12, { trigger: 'scheduled' });
    expect(result).toMatchObject({ status: 'succeeded', attempts: 3, insightCount: 1 });
    // No phantom commitment from the fabricated one.
    expect(h.coachRepo.actions.map((a) => a.title)).toEqual(['Decide whether the Project Y billing fix is finished or dropped']);
    expect(JSON.stringify(h.coachRepo.actions)).not.toContain('made-up');
  });

  it('a missing or mangled coach block cannot sink a good reflection', async () => {
    for (const coach of [undefined, 'advice: work harder', { actions: 'lots' }]) {
      const h = harness();
      const response = { ...modelDay(day12), coach } as Record<string, unknown>;
      if (coach === undefined) delete response.coach;
      h.gemini.push(response, response, response);

      const result = await h.service.generate(day12, { trigger: 'scheduled' });
      expect(result).toMatchObject({ status: 'succeeded', attempts: 3, insightCount: 1 });
      expect(h.coachRepo.actions).toEqual([]);
      expect(h.coachRepo.memories).toEqual([]);
      expect(h.repo.getCurrentReport('day', day12.key)!.coach).toMatchObject({ actionIds: [], followups: [], noActionReason: null });
    }
  });

  it('a Gemini outage changes nothing: the earlier report and its actions stay exactly as they were', async () => {
    const h = harness({ now: local(12, '17:00') });
    h.gemini.push(modelDay(day12));
    await h.service.generate(day12, { trigger: 'manual' });
    const before = structuredClone({ report: h.repo.getCurrentReport('day', day12.key), actions: h.coachRepo.actions, events: h.coachRepo.events });

    h.setNow(local(12, '22:05'));
    const down = new GeminiError('network', 'Gemini network error: offline', true);
    h.gemini.push(down, down, down);
    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'failed', category: 'network' });

    expect(h.repo.getCurrentReport('day', day12.key)).toEqual(before.report);
    expect(h.coachRepo.actions).toEqual(before.actions);
    expect(h.coachRepo.events).toEqual(before.events);
  });

  it('malformed JSON and a missing key are recoverable states, with nothing written', async () => {
    const malformed = harness();
    malformed.gemini.push('{not json', '{still not', 'nope');
    expect(await malformed.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'failed', category: 'malformed_output' });
    expect(malformed.coachRepo.actions).toEqual([]);
    expect((await malformed.service.getView('day', iso(12, '12:00'))).generation).toMatchObject({ state: 'failed', errorCategory: 'malformed_output' });

    const noKey = harness();
    noKey.gemini.configured = false;
    expect(await noKey.service.generate(day12, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'missing_api_key' });
    expect(noKey.repo.reports).toEqual([]);
    expect(noKey.coachRepo.actions).toEqual([]);
  });

  it('report and actions are committed atomically: if the actions cannot be stored, neither is the report', async () => {
    const h = harness();
    h.coachRepo.failNextInsert = true;
    h.gemini.push(modelDay(day12));

    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'failed', category: 'persistence' });
    expect(h.repo.getCurrentReport('day', day12.key)).toBeNull();
    expect(h.coachRepo.actions).toEqual([]);
    expect(h.coachRepo.events).toEqual([]);
  });
});

describe('daily intelligence — regeneration', () => {
  it('replaces its own undecided suggestions, keeps what the user decided, and does not suggest that again', async () => {
    const h = harness({ now: local(12, '17:00') });
    h.gemini.push(modelDay(day12, { actions: [modelAction({ when: 'today', daypart: 'evening' }), secondAction()] }));
    await h.service.generate(day12, { trigger: 'manual' });
    const [focusAction, loopAction] = h.coachRepo.actions;
    expect(focusAction.targetStart).toBe(iso(12, '17:00')); // "today · evening" while the day is running

    // The user commits to one and leaves the other undecided.
    expect(h.coach.decide(focusAction.id, 'accept').ok).toBe(true);

    // 10:05 PM: the scheduled end-of-day report replaces the afternoon one.
    h.setNow(local(12, '22:05'));
    const fresh = secondAction({ title: 'Stop carrying the Project Y loop: finish it or drop it', thread: 'Project Y' });
    const repeat = modelDay(day12, { actions: [modelAction({ when: 'today', daypart: 'evening' }), fresh] });
    h.gemini.push(repeat, modelDay(day12, { actions: [fresh] }));
    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 2 });

    // The model was told what is already open, and was refused when it repeated it.
    expect(h.gemini.requests[1].prompt).toContain('"title":"Run one 45-minute Focus session on Project X before switching threads"');
    expect(h.gemini.requests[2].prompt).toContain('action 1: the user already has this');

    const byId = (id: string) => h.coachRepo.getAction(id)!;
    expect(byId(focusAction.id).status).toBe('review'); // accepted, its evening window has since passed
    expect(byId(focusAction.id).acceptedAt).not.toBeNull();
    expect(byId(loopAction.id).status).toBe('withdrawn');
    const report = h.repo.getCurrentReport('day', day12.key)!;
    expect(report.coach!.actionIds).toHaveLength(1);
    expect(h.coachRepo.listActionsByReport(report.id).map((a) => a.title)).toEqual(['Stop carrying the Project Y loop: finish it or drop it']);
    // Exactly one live suggestion about the Project Y loop.
    expect(h.coachRepo.actions.filter((a) => a.status === 'suggested')).toHaveLength(1);
  });
});

describe('daily intelligence — realistic days', () => {
  const quietHistory = () => [5, 6, 7, 8, 9].flatMap(workday);

  it('a fragmented day: the context carries the fragmentation and the recent days it can be compared with', async () => {
    const fragmented = [
      projectX(12, '09:00', 12), research(12, '09:14', 9), projectY(12, '09:25', 11), browsing(12, '09:38', 8),
      projectX(12, '09:48', 10), research(12, '10:00', 12), projectY(12, '10:14', 9), projectX(12, '10:25', 14),
      browsing(12, '10:41', 10), projectY(12, '10:53', 12),
    ];
    const h = harness({ activities: [...quietHistory(), ...fragmented] });
    h.gemini.push(
      modelDay(
        day12,
        {
          actions: [
            modelAction({
              title: 'Run one 45-minute Focus session on Project X before opening anything else',
              actionType: 'reduce_fragmentation',
              // The day is still running, so only rates are compared with the baseline — not totals.
              metricKeys: ['behavior.switches', 'baseline.behavior.switches_per_hour'],
              rationale: 'Today had 9 context switches in under two hours, with no block long enough to settle into.',
            }),
          ],
        },
        { headline: 'Today broke into short pieces across four threads.', narrative: null },
      ),
    );
    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(h.gemini.requests[0].prompt).toContain('{"key":"behavior.switches","label":"Context switches","value":"9"}');
    expect(h.coachRepo.actions[0]).toMatchObject({ actionType: 'reduce_fragmentation', strategyKey: 'reduce_fragmentation|morning|medium' });
  });

  it('priority drift: a stated priority that received nothing today, visible against the days before', async () => {
    const drifted = [projectY(12, '09:00', 90), research(12, '11:00', 60), browsing(12, '14:00', 45)];
    const h = harness({ activities: [...quietHistory(), ...drifted] });
    h.gemini.push(
      modelDay(
        day12,
        {
          actions: [
            modelAction({
              title: 'Protect the first block of tomorrow for Project X',
              actionType: 'protect_priority',
              focusMinutes: null,
              focusTask: null,
              thread: null,
              priorityId: h.priorityId,
              metricKeys: [`recent.priority.${h.priorityId}.active_days`],
              rationale: 'Work linked to launching Project X appeared on 5 of 5 recent days and not at all today.',
            }),
          ],
        },
        {
          headline: 'Today went to Project Y and research; nothing was linked to launching Project X.',
          narrative: null,
          insights: [
            modelInsight({
              type: 'priority_alignment',
              title: 'No time went toward launching Project X today',
              observation: 'Work linked to launching Project X appeared on 5 of 5 recent days.',
              interpretation: 'Today is the first recent day without it.',
              metricKeys: [`recent.priority.${h.priorityId}.active_days`],
              priorityIds: [h.priorityId],
            }),
          ],
        },
      ),
    );
    expect(await h.service.generate(day12, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(h.coachRepo.actions[0]).toMatchObject({ actionType: 'protect_priority', priorityId: h.priorityId, targetKey: `p:${h.priorityId}` });
    expect(h.coachRepo.actions[0].evidence[0]).toMatchObject({ kind: 'metric', priorityId: h.priorityId, value: '5 of 5' });
  });

  it('a productive, aligned day: no intervention is the right answer, and it is recorded as such', async () => {
    const aligned = [projectX(12, '09:00', 120), projectX(12, '11:10', 70), projectX(12, '14:00', 90)];
    const h = harness({ activities: [...quietHistory(), ...aligned] });
    h.gemini.push(modelDay(day12, { actions: [], noActionReason: 'Project X received long, unbroken blocks; keep doing what you are doing.' }));
    await h.service.generate(day12, { trigger: 'scheduled' });
    expect(h.coachRepo.actions).toEqual([]);
    const view = await h.service.getView('day', iso(12, '12:00'));
    expect(view.report!.coach!.noActionReason).toBe('Project X received long, unbroken blocks; keep doing what you are doing.');
  });

  it('ambiguous evidence is stated as uncertainty, not turned into a claim', async () => {
    const h = harness();
    h.gemini.push(
      modelDay(day12, {
        uncertainty: ['I am not sure whether the afternoon research belonged to Project X or was something separate.'],
      }),
    );
    await h.service.generate(day12, { trigger: 'scheduled' });
    expect(h.repo.getCurrentReport('day', day12.key)!.coach!.uncertainty).toEqual([
      'I am not sure whether the afternoon research belonged to Project X or was something separate.',
    ]);
  });
});
