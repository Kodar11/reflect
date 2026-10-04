import { describe, it, expect } from 'vitest';
import { planReconciliation } from '../../src/intelligence/IntelligenceReconciler';
import { buildSystemInstruction } from '../../src/intelligence/IntelligencePrompt';
import type { IntelligenceActivity, ValidatedActivity } from '../../src/intelligence/IntelligenceModels';
import type { Event } from '../../src/models/Event';
import { evaluateSegmentation, segmentFromEvents, type TimedEvent } from '../benchmark/evaluators/segmentation';
import { makeEvent, makeHarness, modelActivity, modelOutput, t, type Harness } from './helpers';

/**
 * Activity boundaries are semantic, not application boundaries.
 *
 * The model decides what is one task; these tests pin what the PIPELINE must
 * do with that decision: keep one task in one activity across application
 * switches, interruptions and analysis windows, let a later analysis repair an
 * earlier first impression, and still keep genuinely different tasks apart.
 * Gemini is scripted, so every response is the semantic judgement under test.
 */

const window = (hour: number): [string, string] => [t(`${String(hour).padStart(2, '0')}:00`), t(`${String(hour + 1).padStart(2, '0')}:00`)];

/** Active activities in the order they began, with the raw events they own. */
function recorded(h: Harness): { activity: IntelligenceActivity; eventIds: number[] }[] {
  return h.repo
    .active()
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
    .map((activity) => ({ activity, eventIds: h.repo.getActivityEventIds(activity.id) }));
}

async function analyze(h: Harness, hour: number, activities: unknown[]) {
  const [start, end] = window(hour);
  h.gemini.push(modelOutput(activities, [], [start, end]));
  const result = await h.service.analyzeWindow(start, end);
  expect(result.status, JSON.stringify(result)).toBe('succeeded');
  return h.gemini.requests[h.gemini.requests.length - 1];
}

const act = (temporaryId: string, eventIds: number[], hour: number, overrides: Record<string, unknown> = {}) =>
  modelActivity({ temporaryId, eventIds, startedAt: window(hour)[0], endedAt: window(hour)[1], ...overrides });

describe('Semantic continuity — one task is one activity', () => {
  it('VS Code → GitHub → VS Code is one activity, even when the first analysis saw only the start', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:20'), t('09:45'), { app: 'VS Code', title: 'auth.ts - client-app' }),
      makeEvent(2, t('09:45'), t('10:05'), { app: 'Chrome', browser: 'Chrome', url: 'github.com', title: 'Fix token refresh · Pull Request #41' }),
      makeEvent(3, t('10:05'), t('10:40'), { app: 'VS Code', title: 'auth.ts - client-app' }),
    ]);

    // First impression from two events: the browser looked like something else.
    await analyze(h, 9, [
      act('a1', [1], 9, { title: 'Edit auth.ts' }),
      act('a2', [2], 9, { title: 'Browse GitHub', contextId: null }),
    ]);
    const [coding, github] = recorded(h).map((r) => r.activity);

    // The next analysis is shown both recorded activities with their events…
    const request = await analyze(h, 10, [
      act('a1', [1, 2, 3], 10, { continuationOfActivityId: coding.id, startedAt: t('09:20'), title: 'Fix token refresh in client app' }),
    ]);
    expect(request.prompt).toContain(`"id":1,"watcher":"window","startedAt":"${t('09:20')}"`);
    expect(request.prompt).toContain(`"activityId":"${coding.id}"`);
    expect(request.prompt).toContain(`"activityId":"${github.id}"`);

    // …and folds them into the one task they were.
    expect(recorded(h)).toHaveLength(1);
    expect(recorded(h)[0]).toMatchObject({ activity: { id: coding.id, title: 'Fix token refresh in client app' }, eventIds: [1, 2, 3] });
    expect(h.repo.activities.get(github.id)!.supersededAt).not.toBeNull();
  });

  it('VS Code → Slack → VS Code is one activity when Slack is a short interruption', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:10'), t('09:58'), { app: 'VS Code', title: 'billing.ts - saas' }),
      makeEvent(2, t('09:58'), t('10:01'), { app: 'Slack', title: 'Client workspace' }),
      makeEvent(3, t('10:01'), t('10:45'), { app: 'VS Code', title: 'billing.ts - saas' }),
    ]);
    await analyze(h, 9, [act('a1', [1], 9), act('a2', [2], 9, { title: 'Slack', contextId: null })]);
    const coding = recorded(h)[0].activity;

    await analyze(h, 10, [act('a1', [2, 3], 10, { continuationOfActivityId: coding.id })]);

    expect(recorded(h).map((r) => r.eventIds)).toEqual([[1, 2, 3]]);
    expect(recorded(h)[0].activity.id).toBe(coding.id);
  });

  it('coding → docs → tests → coding stays one activity inside a window', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:00'), t('09:20'), { app: 'VS Code', title: 'parser.ts - reflect' }),
      makeEvent(2, t('09:20'), t('09:32'), { app: 'Chrome', browser: 'Chrome', url: 'zod.dev', title: 'Zod | Documentation' }),
      makeEvent(3, t('09:32'), t('09:40'), { app: 'Windows Terminal', title: 'npm test -- parser' }),
      makeEvent(4, t('09:40'), t('09:58'), { app: 'VS Code', title: 'parser.ts - reflect' }),
    ]);
    await analyze(h, 9, [act('a1', [1, 2, 3, 4], 9)]);

    expect(recorded(h).map((r) => r.eventIds)).toEqual([[1, 2, 3, 4]]);
  });

  it('research → implementation → testing → verification is one activity across three analyses', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:10'), t('09:55'), { app: 'Chrome', browser: 'Chrome', url: 'stripe.com', title: 'Webhooks | Stripe Docs' }),
      makeEvent(2, t('09:55'), t('10:50'), { app: 'VS Code', title: 'webhook.ts - saas' }),
      makeEvent(3, t('10:50'), t('11:15'), { app: 'Windows Terminal', title: 'npm test -- webhook' }),
      makeEvent(4, t('11:15'), t('11:40'), { app: 'Chrome', browser: 'Chrome', url: 'staging.example.com', title: 'Billing — staging' }),
    ]);
    await analyze(h, 9, [act('a1', [1, 2], 9, { title: 'Research Stripe webhooks' })]);
    const task = recorded(h)[0].activity;
    await analyze(h, 10, [act('a1', [2, 3], 10, { continuationOfActivityId: task.id, title: 'Implement Stripe webhooks' })]);
    await analyze(h, 11, [act('a1', [3, 4], 11, { continuationOfActivityId: task.id, title: 'Implement and verify Stripe webhooks' })]);

    expect(recorded(h)).toHaveLength(1);
    expect(recorded(h)[0]).toMatchObject({
      activity: { id: task.id, title: 'Implement and verify Stripe webhooks', startedAt: t('09:10'), endedAt: t('11:40') },
      eventIds: [1, 2, 3, 4],
    });
  });

  it('a long activity crossing several analysis windows stays one continuous activity', async () => {
    const events: Event[] = [];
    for (let i = 0; i < 9; i++) {
      const start = 9 * 60 + i * 20;
      const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      events.push(makeEvent(i + 1, t(hhmm(start)), t(hhmm(start + 20)), { app: 'VS Code', title: `module${i}.ts - reflect` }));
    }
    const h = makeHarness(events);
    await analyze(h, 9, [act('a1', [1, 2, 3], 9)]);
    const task = recorded(h)[0].activity;
    // The model only has to say "this carries on"; it need not restate what it already owns.
    await analyze(h, 10, [act('a1', [4, 5, 6], 10, { continuationOfActivityId: task.id })]);
    const third = await analyze(h, 11, [act('a1', [7, 8, 9], 11, { continuationOfActivityId: task.id })]);

    expect(recorded(h)).toHaveLength(1);
    expect(recorded(h)[0]).toMatchObject({ activity: { id: task.id, startedAt: t('09:00'), endedAt: t('12:00') }, eventIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
    // The whole recent stretch is evidence for the third analysis, not just its own hour.
    expect(third.prompt).toContain('EVENTS (9, chronological)');
  });

  it('an activity left unmentioned by a later analysis keeps its events', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:10'), t('09:50'), { app: 'VS Code', title: 'a.ts - reflect' }),
      makeEvent(2, t('10:05'), t('10:40'), { app: 'Chrome', browser: 'Chrome', url: 'netflix.com', title: 'Netflix' }),
    ]);
    await analyze(h, 9, [act('a1', [1], 9)]);
    await analyze(h, 10, [act('a1', [2], 10, { title: 'Watch Netflix', contextId: null, areaId: 'area_leisure', intentId: 'intent_consume' })]);

    expect(recorded(h).map((r) => r.eventIds)).toEqual([[1], [2]]);
  });
});

describe('Semantic continuity — genuine boundaries are kept', () => {
  it('coding → a long unrelated Netflix session is two activities, across the window boundary too', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:00'), t('09:40'), { app: 'VS Code', title: 'timeline.ts - reflect' }),
      makeEvent(2, t('09:40'), t('10:10'), { app: 'Chrome', browser: 'Chrome', url: 'netflix.com', title: 'Netflix' }),
      makeEvent(3, t('10:10'), t('10:50'), { app: 'Chrome', browser: 'Chrome', url: 'netflix.com', title: 'Episode 4 | Netflix' }),
    ]);
    const leisure = { title: 'Watch Netflix', contextId: null, areaId: 'area_leisure', intentId: 'intent_consume', qualityId: null };
    await analyze(h, 9, [act('a1', [1], 9), act('a2', [2], 9, leisure)]);
    const [coding, netflix] = recorded(h).map((r) => r.activity);

    await analyze(h, 10, [act('a1', [2, 3], 10, { ...leisure, continuationOfActivityId: netflix.id })]);

    expect(recorded(h).map((r) => [r.activity.id, r.eventIds])).toEqual([
      [coding.id, [1]],
      [netflix.id, [2, 3]],
    ]);
    expect(recorded(h)[1].activity.areaId).toBe('area_leisure');
  });

  it('A → sustained unrelated B → A: B stays separate and the return resumes A instead of fragmenting it', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:00'), t('09:40'), { app: 'VS Code', title: 'auth.ts - client-app' }),
      makeEvent(2, t('09:40'), t('10:25'), { app: 'Chrome', browser: 'Chrome', url: 'youtube.com', title: 'Match highlights' }),
      makeEvent(3, t('10:25'), t('10:55'), { app: 'VS Code', title: 'auth.ts - client-app' }),
    ]);
    const leisure = { title: 'Watch match highlights', contextId: null, areaId: 'area_leisure', intentId: 'intent_consume', qualityId: null };
    await analyze(h, 9, [act('a1', [1], 9, { title: 'Fix client auth' }), act('a2', [2], 9, leisure)]);
    const [a, b] = recorded(h).map((r) => r.activity);

    // 45 minutes passed since A ended — but they were spent on B, not away.
    await analyze(h, 10, [
      act('a1', [3], 10, { continuationOfActivityId: a.id, title: 'Fix client auth' }),
      act('a2', [2], 10, { ...leisure, continuationOfActivityId: b.id }),
    ]);

    expect(recorded(h).map((r) => [r.activity.id, r.eventIds])).toEqual([
      [a.id, [1, 3]],
      [b.id, [2]],
    ]);
    expect(recorded(h)[0].activity).toMatchObject({ startedAt: t('09:00'), endedAt: t('10:55'), areaId: 'area_work' });
  });

  it('accepts A → B → A in a single analysis without a retry', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:00'), t('09:20'), { app: 'VS Code', title: 'auth.ts - client-app' }),
      makeEvent(2, t('09:20'), t('09:38'), { app: 'Chrome', browser: 'Chrome', url: 'youtube.com', title: 'Match highlights' }),
      makeEvent(3, t('09:38'), t('09:58'), { app: 'VS Code', title: 'auth.ts - client-app' }),
    ]);
    h.gemini.push(
      modelOutput([
        act('a1', [1, 3], 9),
        act('a2', [2], 9, { title: 'Watch match highlights', contextId: null, areaId: 'area_leisure', intentId: 'intent_consume' }),
      ]),
    );
    const result = await h.service.analyzeWindow(...window(9));

    expect(result).toMatchObject({ status: 'succeeded', attempts: 1, activitiesCreated: 2 });
    expect(recorded(h).map((r) => r.eventIds)).toEqual([[1, 3], [2]]);
  });

  it('the same application with clearly different purposes stays two activities', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:00'), t('09:35'), { app: 'VS Code', title: 'invoice.ts - client-app' }),
      makeEvent(2, t('09:35'), t('10:20'), { app: 'VS Code', title: 'onboarding.tsx - own-saas' }),
      makeEvent(3, t('10:20'), t('10:50'), { app: 'VS Code', title: 'welcome.tsx - own-saas' }),
    ]);
    await analyze(h, 9, [act('a1', [1], 9, { title: 'Client invoicing fix' }), act('a2', [2], 9, { title: 'Build SaaS onboarding' })]);
    const [client, saas] = recorded(h).map((r) => r.activity);

    await analyze(h, 10, [act('a1', [2, 3], 10, { continuationOfActivityId: saas.id, title: 'Build SaaS onboarding' })]);

    expect(recorded(h).map((r) => [r.activity.id, r.activity.title, r.eventIds])).toEqual([
      [client.id, 'Client invoicing fix', [1]],
      [saas.id, 'Build SaaS onboarding', [2, 3]],
    ]);
  });

  it('an absence still ends an activity: nothing tracked for an hour is not an interruption', async () => {
    const h = makeHarness([
      makeEvent(1, t('09:00'), t('09:40'), { app: 'VS Code', title: 'a.ts - reflect' }),
      makeEvent(2, t('10:40'), t('10:58'), { app: 'VS Code', title: 'a.ts - reflect' }),
    ]);
    await analyze(h, 9, [act('a1', [1], 9)]);
    const first = recorded(h)[0].activity;

    // The model restates the old event and continues — the old activity keeps
    // what it had and only the new event starts a new one.
    await analyze(h, 10, [act('a1', [1, 2], 10, { continuationOfActivityId: first.id, startedAt: t('09:00') })]);

    expect(recorded(h).map((r) => r.eventIds)).toEqual([[1], [2]]);
    expect(recorded(h)[0].activity.id).toBe(first.id);
  });

  it('a user-edited activity in the lookback is never revised by hindsight', async () => {
    const edited = new Set<number>();
    const h = makeHarness(
      [
        makeEvent(1, t('09:10'), t('09:50'), { app: 'Chrome', browser: 'Chrome', url: 'youtube.com', title: 'Conference talk' }),
        makeEvent(2, t('10:00'), t('10:40'), { app: 'VS Code', title: 'notes.md - saas' }),
      ],
      [],
      { getUserEditedEventIds: () => [...edited] },
    );
    await analyze(h, 9, [act('a1', [1], 9, { title: 'Watch conference talk' })]);
    const mine = recorded(h)[0].activity;
    edited.add(1);

    await analyze(h, 10, [act('a1', [1, 2], 10, { continuationOfActivityId: mine.id, startedAt: t('09:10'), title: 'Research and notes' })]);

    expect(h.repo.getActivityEventIds(mine.id)).toEqual([1]);
    expect(h.repo.activities.get(mine.id)).toMatchObject({ title: 'Watch conference talk', userLocked: true });
    expect(recorded(h).map((r) => r.eventIds)).toEqual([[1], [2]]);
  });
});

describe('Semantic continuity — reconciliation rules', () => {
  const events = [
    { id: 1, startedAt: t('09:00'), endedAt: t('09:20') },
    { id: 2, startedAt: t('09:20'), endedAt: t('10:10') },
    { id: 3, startedAt: t('10:10'), endedAt: t('10:30') },
    { id: 4, startedAt: t('11:30'), endedAt: t('11:50') },
  ];
  const validated = (eventIds: number[], continuationOfActivityId: string | null): ValidatedActivity => ({
    temporaryId: 'a1',
    continuationOfActivityId,
    startedAt: t('09:00'),
    endedAt: t('11:50'),
    title: 'Task',
    summary: null,
    eventIds,
    contextId: null,
    areaId: null,
    intentId: null,
    qualityId: null,
    confidence: 0.8,
    uncertainty: [],
  });
  const plan = (activities: ValidatedActivity[]) =>
    planReconciliation({
      windowEvents: events,
      activities,
      droppedEventIds: [],
      memberships: new Map([
        [1, { activityId: 'ai-a', userLocked: false }],
        [2, { activityId: 'ai-b', userLocked: false }],
      ]),
      previous: new Map([
        ['ai-a', { userLocked: false, endedAt: t('09:20') }],
        ['ai-b', { userLocked: false, endedAt: t('10:10') }],
      ]),
      protectedEventIds: new Set(),
      maxContinuationGapMs: 30 * 60_000,
      newId: () => 'new-1',
    });

  it('time spent on another activity is an interruption, not a silence', () => {
    // 50 minutes after ai-a ended, all of them tracked (event 2).
    expect(plan([validated([3], 'ai-a')])).toMatchObject({ create: [], extend: [{ activityId: 'ai-a', addEventIds: [3] }] });
  });

  it('untracked time is a silence and ends the activity', () => {
    // 60 minutes after event 3 with nothing tracked.
    const result = plan([validated([4], 'ai-b')]);
    expect(result.extend).toEqual([]);
    expect(result.create).toMatchObject([{ id: 'new-1', eventIds: [4] }]);
  });

  it('a refused continuation does not take the events the previous activity already owns', () => {
    const result = plan([validated([2, 4], 'ai-b')]);
    expect(result.create).toMatchObject([{ id: 'new-1', eventIds: [4] }]);
    expect(result.detach).toEqual([]);
  });

  it('merging recorded activities empties the absorbed one', () => {
    const result = plan([validated([1, 2, 3], 'ai-a')]);
    expect(result.extend).toMatchObject([{ activityId: 'ai-a', addEventIds: [1, 2, 3] }]);
    expect(result.detach).toEqual([{ activityId: 'ai-b', eventIds: [2] }]);
  });
});

describe('Semantic continuity — the contract given to the model', () => {
  const system = buildSystemInstruction();

  it('asks whether the task changed, not whether the application did', () => {
    expect(system).toContain('have they started doing something meaningfully different?');
    expect(system).toContain('A change of application, window, tab or domain is weak evidence on its own and never sufficient.');
    expect(system).toContain('Continue the current activity by default.');
  });

  it('covers interruptions, returning, hindsight and uncertainty', () => {
    expect(system).toContain('A brief detour');
    expect(system).toContain('it does not end the activity it interrupted');
    expect(system).toContain('nothing recorded so far is final');
    expect(system).toContain('Uncertainty is never a reason to split.');
    expect(system).toContain('Do not invent a project or purpose the evidence does not support.');
  });

  it('does not ask for merging at any cost', () => {
    expect(system).toContain('Do not merge for its own sake either');
    expect(system).not.toContain('must not overlap in time');
  });
});

describe('Semantic continuity — the benchmark shape that used to fragment', () => {
  /**
   * Founder/freelancer day 20, 11:52–13:28: one review of the SaaS beta —
   * roadmap, analytics, a search, the live product — at about two events an
   * hour. Analysed hour by hour with no evidence but the hour's own two or
   * three events, it was recorded as four activities, one per application.
   */
  const day = '2026-09-20';
  const events = [
    makeEvent(461, t('05:49', day), t('06:22', day), { app: 'WhatsApp', title: 'WhatsApp' }),
    makeEvent(462, t('06:22', day), t('06:47', day), { app: 'Notion', title: 'SaaS Roadmap' }),
    makeEvent(463, t('06:47', day), t('07:16', day), { app: 'Chrome', browser: 'Chrome', url: 'app.posthog.com', title: 'Analytics dashboard' }),
    makeEvent(464, t('07:16', day), t('07:33', day), { app: 'Chrome', browser: 'Chrome', url: 'google.com', title: 'Google Search' }),
    makeEvent(465, t('07:33', day), t('07:58', day), { app: 'Chrome', browser: 'Chrome', url: 'app.example.com', title: 'SaaS app' }),
  ];
  const groundTruth = [
    { id: 'gt-personal', eventIds: [461] },
    { id: 'gt-review', eventIds: [462, 463, 464, 465] },
  ];
  const at = (hhmm: string): [string, string] => [t(hhmm, day), t(`${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, '0')}:30`, day)];

  it('converges on one activity for the review, and keeps the personal chat apart', async () => {
    const h = makeHarness(events);
    const run = async (hhmm: string, activities: unknown[]) => {
      const [start, end] = at(hhmm);
      h.gemini.push(modelOutput(activities, [], [start, end]));
      expect((await h.service.analyzeWindow(start, end)).status).toBe('succeeded');
    };
    const base = { startedAt: t('06:00', day), endedAt: t('06:30', day) };
    const review = { title: 'SaaS beta usage review', contextId: null };

    await run('05:30', [
      modelActivity({ ...base, temporaryId: 'a1', eventIds: [461], title: 'Messaging on WhatsApp', contextId: null }),
      modelActivity({ ...base, temporaryId: 'a2', eventIds: [462], title: 'Reviewing SaaS Roadmap in Notion', contextId: null }),
    ]);
    const roadmap = recorded(h)[1].activity;
    await run('06:30', [
      modelActivity({ ...base, ...review, temporaryId: 'a1', eventIds: [462, 463, 464], continuationOfActivityId: roadmap.id }),
    ]);
    await run('07:30', [
      modelActivity({ ...base, ...review, temporaryId: 'a1', eventIds: [464, 465], continuationOfActivityId: roadmap.id }),
    ]);

    const timed: TimedEvent[] = events.map((e) => ({ id: e.id, startMs: Date.parse(e.startedAt), endMs: Date.parse(e.endedAt) }));
    const byId = new Map(timed.map((e) => [e.id, e]));
    const result = evaluateSegmentation(
      groundTruth.map((g) => segmentFromEvents(g.id, g.eventIds, byId)),
      recorded(h).map((r) => segmentFromEvents(r.activity.id, r.eventIds, byId)),
      timed,
      { iouThreshold: 0.5, boundaryToleranceMs: 60_000, minOverlapMs: 60_000 },
    );

    expect(result.metrics).toMatchObject({
      predictedCount: 2,
      matchedCount: 2,
      precision: 1,
      recall: 1,
      overSegmentationRatio: 1,
      underSegmentationRatio: 1,
      boundaryF1: 1,
    });
    expect(recorded(h)[1].activity).toMatchObject({ id: roadmap.id, title: 'SaaS beta usage review' });
  });
});
