import { describe, it, expect } from 'vitest';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import { IntelligenceScheduler } from '../../src/intelligence/IntelligenceScheduler';
import { IntelligenceService } from '../../src/intelligence/IntelligenceService';
import { makeEvent, makeHarness, modelActivity, modelOutput, t } from './helpers';

const WS = t('09:00');
const WE = t('10:00');

/** VS Code → Chrome → ChatGPT → Terminal → VS Code, all inside 09:00–10:00. */
function codingHour() {
  return [
    makeEvent(1, t('09:00'), t('09:15'), { app: 'VS Code', title: 'GeminiClient.ts - reflect' }),
    makeEvent(2, t('09:15'), t('09:25'), { app: 'Chrome', browser: 'Chrome', url: 'ai.google.dev', title: 'Structured output' }),
    makeEvent(3, t('09:25'), t('09:35'), { app: 'Chrome', browser: 'Chrome', url: 'chatgpt.com', title: 'Zod schema help' }),
    makeEvent(4, t('09:35'), t('09:40'), { app: 'Windows Terminal', title: 'npm test' }),
    makeEvent(5, t('09:40'), t('09:58'), { app: 'VS Code', title: 'IntelligenceService.ts - reflect' }),
  ];
}

describe('IntelligenceService — analysis + persistence', () => {
  it('combines several applications into one persisted activity without touching raw events', async () => {
    const events = codingHour();
    const snapshot = JSON.parse(JSON.stringify(events));
    const h = makeHarness(events, [
      modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], startedAt: t('09:00'), endedAt: t('09:58') })]),
    ]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'succeeded', activitiesCreated: 1, activitiesExtended: 0, attempts: 1 });
    const [activity] = h.repo.active();
    expect(activity).toMatchObject({
      title: 'Implement Reflect Gemini integration',
      contextId: 'coding',
      areaId: 'area_work',
      intentId: 'intent_create',
      qualityId: 'quality_focused',
      startedAt: t('09:00'),
      endedAt: t('09:58'),
      userLocked: false,
    });
    expect(h.repo.getActivityEventIds(activity.id)).toEqual([1, 2, 3, 4, 5]);
    expect(h.events.events).toEqual(snapshot); // raw facts untouched
  });

  it('uses backend-generated canonical ids, never the model temporaryId', async () => {
    const h = makeHarness(codingHour(), [
      modelOutput([modelActivity({ temporaryId: 'a1', eventIds: [1, 2, 3, 4, 5], endedAt: t('09:58') })]),
    ]);
    await h.service.analyzeWindow(WS, WE);

    const [activity] = h.repo.active();
    expect(activity.id).toMatch(/^ai-[0-9a-f-]{36}$/);
    expect(activity.id).not.toBe('a1');
  });

  it('splits genuinely different activities', async () => {
    const events = [
      makeEvent(1, t('09:00'), t('09:20'), { app: 'VS Code', title: 'TimelinePage.tsx - reflect' }),
      makeEvent(2, t('09:20'), t('09:35'), { app: 'Chrome', url: 'youtube.com', title: 'Volleyball highlights' }),
      makeEvent(3, t('09:35'), t('09:45'), { app: 'Chrome', url: 'instagram.com', title: 'Instagram' }),
      makeEvent(4, t('09:45'), t('10:00'), { app: 'VS Code', title: 'TimelinePage.tsx - reflect' }),
    ];
    const h = makeHarness(events, [
      modelOutput([
        modelActivity({ temporaryId: 'a1', eventIds: [1], startedAt: t('09:00'), endedAt: t('09:20'), title: 'Build Reflect timeline UI' }),
        modelActivity({
          temporaryId: 'a2',
          eventIds: [2, 3],
          startedAt: t('09:20'),
          endedAt: t('09:45'),
          title: 'Watch videos and browse social media',
          contextId: null,
          areaId: 'area_leisure',
          intentId: 'intent_consume',
          qualityId: null,
        }),
        modelActivity({ temporaryId: 'a3', eventIds: [4], startedAt: t('09:45'), endedAt: t('10:00'), title: 'Build Reflect timeline UI' }),
      ]),
    ]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'succeeded', activitiesCreated: 3 });
    expect(h.repo.active().map((a) => h.repo.getActivityEventIds(a.id))).toEqual([[1], [2, 3], [4]]);
    expect(h.repo.active()[1]).toMatchObject({ areaId: 'area_leisure', contextId: null });
  });

  it('continues an activity from the previous window instead of duplicating it', async () => {
    const events = [
      ...codingHour(),
      makeEvent(6, t('10:00'), t('10:25'), { app: 'VS Code', title: 'IntelligenceService.ts - reflect' }),
      makeEvent(7, t('10:25'), t('10:40'), { app: 'Windows Terminal', title: 'npx tsc' }),
    ];
    const h = makeHarness(events, [
      modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], endedAt: t('09:58') })]),
    ]);
    await h.service.analyzeWindow(WS, WE);
    const original = h.repo.active()[0];

    h.gemini.push(
      modelOutput(
        [
          modelActivity({
            eventIds: [6, 7],
            continuationOfActivityId: original.id,
            startedAt: t('10:00'),
            endedAt: t('10:40'),
            summary: 'Kept building the pipeline.',
          }),
        ],
        [],
        [t('10:00'), t('11:00')],
      ),
    );
    const result = await h.service.analyzeWindow(t('10:00'), t('11:00'));

    expect(result).toMatchObject({ status: 'succeeded', activitiesCreated: 0, activitiesExtended: 1 });
    expect(h.repo.active()).toHaveLength(1);
    const extended = h.repo.active()[0];
    expect(extended.id).toBe(original.id);
    expect(extended).toMatchObject({ startedAt: t('09:00'), endedAt: t('10:40'), summary: 'Kept building the pipeline.' });
    expect(h.repo.getActivityEventIds(extended.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // The previous activity was offered to the model with its existing id.
    expect(h.gemini.requests[1].prompt).toContain(`"id":"${original.id}"`);
    expect(JSON.stringify(h.gemini.requests[1].responseJsonSchema)).toContain(original.id);
  });

  it('does not continue an activity across a long silence', async () => {
    const events = [
      makeEvent(1, t('09:00'), t('09:50'), { app: 'VS Code', title: 'a.ts - reflect' }),
      makeEvent(2, t('10:45'), t('10:59'), { app: 'VS Code', title: 'a.ts - reflect' }),
    ];
    const h = makeHarness(events, [modelOutput([modelActivity({ eventIds: [1], endedAt: t('09:50') })])]);
    await h.service.analyzeWindow(WS, WE);
    const first = h.repo.active()[0];

    h.gemini.push(
      modelOutput(
        [modelActivity({ eventIds: [2], continuationOfActivityId: first.id, startedAt: t('10:45'), endedAt: t('10:59') })],
        [],
        [t('10:00'), t('11:00')],
      ),
    );
    const result = await h.service.analyzeWindow(t('10:00'), t('11:00'));

    // 55 minutes of silence → a new block rather than one stretched across the gap.
    expect(result).toMatchObject({ activitiesCreated: 1, activitiesExtended: 0 });
    expect(h.repo.active()).toHaveLength(2);
    expect(h.repo.getActivityEventIds(first.id)).toEqual([1]);
  });

  it('keeps an event that crosses the hour boundary in one activity', async () => {
    const events = [
      makeEvent(1, t('09:10'), t('09:50'), { app: 'VS Code', title: 'a.ts - reflect' }),
      makeEvent(2, t('09:50'), t('10:20'), { app: 'VS Code', title: 'b.ts - reflect' }), // crosses 10:00
      makeEvent(3, t('10:20'), t('10:50'), { app: 'VS Code', title: 'c.ts - reflect' }),
    ];
    const h = makeHarness(events, [modelOutput([modelActivity({ eventIds: [1, 2], startedAt: t('09:10'), endedAt: t('10:00') })])]);
    await h.service.analyzeWindow(WS, WE);
    const first = h.repo.active()[0];

    // The crossing event is shown again in the next window, clipped to it.
    h.gemini.push(
      modelOutput(
        [modelActivity({ eventIds: [2, 3], continuationOfActivityId: first.id, startedAt: t('10:00'), endedAt: t('10:50') })],
        [],
        [t('10:00'), t('11:00')],
      ),
    );
    await h.service.analyzeWindow(t('10:00'), t('11:00'));

    expect(h.gemini.requests[1].prompt).toContain(`"id":2,"watcher":"window","startedAt":"${t('10:00')}"`);
    expect(h.repo.active()).toHaveLength(1);
    expect(h.repo.getActivityEventIds(first.id)).toEqual([1, 2, 3]);
    expect(h.events.byId(2)).toMatchObject({ startedAt: t('09:50'), endedAt: t('10:20') });
  });

  it('is idempotent: an analysed window is not sent to Gemini again', async () => {
    const h = makeHarness(codingHour(), [modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], endedAt: t('09:58') })])]);
    await h.service.analyzeWindow(WS, WE);

    const again = await h.service.analyzeWindow(WS, WE);

    expect(again).toEqual({ status: 'skipped', reason: 'already_analyzed', windowStart: WS, windowEnd: WE });
    expect(h.gemini.requests).toHaveLength(1);
    expect(h.repo.active()).toHaveLength(1);
    expect(h.repo.runs).toHaveLength(1);
  });

  it('a forced re-analysis replaces stale interpretations incrementally', async () => {
    const h = makeHarness(codingHour(), [modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], endedAt: t('09:58') })])]);
    await h.service.analyzeWindow(WS, WE);
    const original = h.repo.active()[0];

    h.gemini.push(
      modelOutput([
        modelActivity({ temporaryId: 'a1', eventIds: [1, 2, 3], startedAt: t('09:00'), endedAt: t('09:35'), title: 'Research Gemini structured output' }),
        modelActivity({ temporaryId: 'a2', eventIds: [4, 5], startedAt: t('09:35'), endedAt: t('09:58'), title: 'Implement IntelligenceService' }),
      ]),
    );
    const result = await h.service.analyzeWindow(WS, WE, { force: true });

    expect(result.status).toBe('succeeded');
    expect(h.repo.active().map((a) => a.title)).toEqual(['Research Gemini structured output', 'Implement IntelligenceService']);
    expect(h.repo.activities.get(original.id)!.supersededAt).not.toBeNull();
    // Exactly one successful run per window.
    expect(h.repo.runs.map((r) => r.status)).toEqual(['superseded', 'succeeded']);
  });

  it('does not call Gemini for a window with no events', async () => {
    const h = makeHarness([makeEvent(1, t('07:00'), t('07:30'), { app: 'VS Code' })]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'skipped', reason: 'no_events' });
    expect(h.gemini.requests).toHaveLength(0);
    expect(h.repo.runs).toHaveLength(0);
  });

  it('sends only user rules, focus context and the allowed taxonomy — never payload or system rules', async () => {
    const events = [makeEvent(1, t('09:00'), t('09:30'), { app: 'VS Code', title: 'nash.py - GameTheory', payload: '{"id":31337}' })];
    const h = makeHarness(events, [modelOutput([modelActivity({ eventIds: [1] })])]);
    h.rules.push(
      { id: 'rule_coding', activityId: 'coding', conditions: '[{"type":"app_equals","value":"VS Code"}]', enabled: 1, priority: 0, areaId: null, intentId: null, qualityId: null, source: 'system' },
      { id: 'rule_hobby', activityId: 'learning', conditions: '[{"type":"title_contains","value":"GameTheory"}]', enabled: 1, priority: 10, areaId: 'area_leisure', intentId: null, qualityId: null, source: 'user' },
      { id: 'rule_off', activityId: 'coding', conditions: '[{"type":"app_equals","value":"Figma"}]', enabled: 0, priority: 0, areaId: null, intentId: null, qualityId: null, source: 'user' },
    );
    h.focusSessions.push({
      id: 'f1', profileId: 'default-deep-work', task: 'Study mixed strategies', notes: null, mode: 'stopwatch',
      plannedDurationMinutes: null, state: 'completed', startedAt: t('08:55'), endedAt: t('09:40'), pausedAt: null,
      totalPauseMs: 0, elapsedMs: 0, blockingLeaseId: null, createdAt: t('08:55'), updatedAt: t('09:40'),
    });

    await h.service.analyzeWindow(WS, WE);
    const { prompt, systemInstruction } = h.gemini.requests[0];

    expect(prompt).toContain('"id":"rule_hobby"');
    expect(prompt).not.toContain('rule_coding'); // seeded default is not user knowledge
    expect(prompt).not.toContain('rule_off');
    expect(prompt).toContain('{"task":"Study mixed strategies","profileName":"Deep Work"');
    expect(prompt).toContain('{"id":"coding","name":"Coding"}');
    expect(prompt).toContain('Computer Science student');
    expect(prompt).not.toContain('31337');
    expect(systemInstruction).toContain('You are Reflect');
  });
});

describe('IntelligenceService — failure handling', () => {
  const okOutput = () => modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], endedAt: t('09:58') })]);

  it('missing API key: clear non-fatal error, nothing written', async () => {
    const h = makeHarness(codingHour());
    h.gemini.configured = false;

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'failed', category: 'missing_api_key', runId: null, attempts: 0 });
    expect(h.gemini.requests).toHaveLength(0);
    expect(h.repo.runs).toHaveLength(0);
    expect(h.repo.active()).toHaveLength(0);
    expect((await h.service.processBacklog()).status).toBe('unavailable');
  });

  it('network error: retries twice with backoff, then marks the run failed', async () => {
    const offline = () => new GeminiError('network', 'Gemini network error: fetch failed', true);
    const h = makeHarness(codingHour(), [offline(), offline(), offline()]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'failed', category: 'network', attempts: 3 });
    expect(h.gemini.requests).toHaveLength(3); // never retries indefinitely
    expect(h.sleeps).toEqual([1000, 4000]);
    expect(h.repo.runs[0]).toMatchObject({ status: 'failed', errorCategory: 'network', attemptCount: 3 });
    expect(h.repo.active()).toHaveLength(0);
  });

  it('recovers when a retry succeeds', async () => {
    const h = makeHarness(codingHour(), [new GeminiError('quota', 'rate limited', true, 429), okOutput()]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.repo.runs[0]).toMatchObject({ status: 'succeeded', attemptCount: 2, model: 'test-model-001' });
  });

  it('does not retry a non-retryable API error', async () => {
    const h = makeHarness(codingHour(), [new GeminiError('api', 'Gemini API error (400): bad request', false, 400), okOutput()]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'failed', category: 'api', attempts: 1 });
    expect(h.gemini.requests).toHaveLength(1);
  });

  it('invalid (non-JSON) response: retried, then failed as malformed_output', async () => {
    const h = makeHarness(codingHour(), ['Sure! Here is the timeline…', '{"activities": [', 'not json']);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'failed', category: 'malformed_output', attempts: 3 });
    expect(h.repo.runs[0]).toMatchObject({ status: 'failed', errorCategory: 'malformed_output' });
    expect(h.repo.active()).toHaveLength(0);
  });

  it('validation failure: nothing unsafe is written and the retry is told why', async () => {
    const invented = modelOutput([modelActivity({ eventIds: [1, 2, 999], contextId: 'made_up_context' })]);
    const h = makeHarness(codingHour(), [invented, okOutput()]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.gemini.requests[1].prompt).toContain('YOUR PREVIOUS RESPONSE WAS REJECTED');
    expect(h.gemini.requests[1].prompt).toContain('unknown event id 999');
    expect(h.repo.active()).toHaveLength(1);
    expect(h.repo.active()[0].contextId).toBe('coding');
  });

  it('unknown classifications never reach the database, even after every retry', async () => {
    const invented = () => modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], areaId: 'area_invented' })]);
    const h = makeHarness(codingHour(), [invented(), invented(), invented()]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'failed', category: 'validation', attempts: 3 });
    expect(h.repo.activities.size).toBe(0);
  });

  it('persistence failure: the previous valid AI state stays intact', async () => {
    const h = makeHarness(codingHour(), [okOutput()]);
    await h.service.analyzeWindow(WS, WE);
    const before = JSON.stringify([...h.repo.activities.values()]);
    const membersBefore = JSON.stringify([...h.repo.members]);

    h.gemini.push(modelOutput([modelActivity({ eventIds: [1, 2, 3, 4, 5], title: 'Something else' })]));
    h.repo.failNextCommit = new Error('SQLITE_BUSY: database is locked');
    const result = await h.service.analyzeWindow(WS, WE, { force: true });

    expect(result).toMatchObject({ status: 'failed', category: 'persistence' });
    expect(result.status === 'failed' && result.error).toContain('SQLITE_BUSY');
    expect(JSON.stringify([...h.repo.activities.values()])).toBe(before);
    expect(JSON.stringify([...h.repo.members])).toBe(membersBefore);
    expect(h.repo.runs.map((r) => r.status)).toEqual(['succeeded', 'failed']);
    expect(h.repo.runs[1].errorCategory).toBe('persistence');
  });

  it('internal errors are reported, never thrown', async () => {
    const h = makeHarness(codingHour(), [new TypeError('boom')]);

    const result = await h.service.analyzeWindow(WS, WE);

    expect(result).toMatchObject({ status: 'failed', category: 'internal', error: 'boom' });
    expect(h.repo.runs[0]).toMatchObject({ status: 'failed', errorCategory: 'internal' });
    expect(await h.service.analyzeWindow('garbage', WE)).toMatchObject({ status: 'failed', category: 'internal' });
  });
});

describe('IntelligenceService — backlog + scheduler', () => {
  /** Local wall-clock time on a fixed day (backlog windows are local-hour aligned). */
  const local = (h: number, m = 0) => new Date(2026, 2, 2, h, m, 0, 0).toISOString();

  function shutdownScenario() {
    // Worked 09:20–09:58, shut down, came back at 12:00.
    const events = [
      makeEvent(1, local(9, 20), local(9, 40), { app: 'VS Code', title: 'a.ts - reflect' }),
      makeEvent(2, local(9, 40), local(9, 58), { app: 'Chrome', url: 'react.dev', title: 'useEffect' }),
    ];
    const output = () =>
      modelOutput([modelActivity({ eventIds: [1, 2], startedAt: local(9, 20), endedAt: local(9, 58) })], [], [local(9), local(10)]);
    const h = makeHarness(events, [output()]);
    h.setNow(local(12, 0));
    return { h, output };
  }

  it('discovers the unprocessed historical window and skips empty ones', async () => {
    const { h } = shutdownScenario();

    const backlog = await h.service.processBacklog();

    expect(backlog).toMatchObject({ status: 'completed', windowsConsidered: 1 });
    expect(backlog.results[0]).toMatchObject({ status: 'succeeded', windowStart: local(9), windowEnd: local(10) });
    expect(h.gemini.requests).toHaveLength(1); // 10:00–12:00 had no events → never sent
    expect(h.repo.active()).toHaveLength(1);
  });

  it('does not send a processed window twice', async () => {
    const { h } = shutdownScenario();
    await h.service.processBacklog();

    const again = await h.service.processBacklog();

    expect(again).toMatchObject({ status: 'completed', windowsConsidered: 0, results: [] });
    expect(h.gemini.requests).toHaveLength(1);
  });

  it('leaves the still-running hour for the next cycle', async () => {
    const { h } = shutdownScenario();
    h.events.events.push(makeEvent(3, local(12, 5), local(12, 20), { app: 'VS Code', title: 'b.ts' }));
    h.setNow(local(12, 30));

    const backlog = await h.service.processBacklog();

    expect(backlog.results.map((r) => r.windowStart)).toEqual([local(9)]);
  });

  it('processes several backlog windows chronologically', async () => {
    const { h } = shutdownScenario();
    h.events.events.push(makeEvent(3, local(10, 30), local(10, 50), { app: 'Figma', title: 'Timeline mock' }));
    h.gemini.push(
      modelOutput([modelActivity({ eventIds: [3], startedAt: local(10, 30), endedAt: local(10, 50), title: 'Design Reflect timeline UI' })], [], [local(10), local(11)]),
    );

    const backlog = await h.service.processBacklog();

    expect(backlog.results.map((r) => [r.status, r.windowStart])).toEqual([
      ['succeeded', local(9)],
      ['succeeded', local(10)],
    ]);
  });

  it('restart resumes safely after an interrupted run', async () => {
    const { h, output } = shutdownScenario();
    // The app died mid-analysis: a run is stuck in 'running', nothing persisted.
    h.repo.createRun({ id: 'crashed', windowStart: local(9), windowEnd: local(10), model: 'm', promptVersion: 'p', schemaVersion: 1, nowIso: local(10, 2) });

    // New process: fresh service + scheduler over the same stores.
    const restarted = makeHarness(h.events.events, [output()]);
    restarted.setNow(local(12, 0));
    const service = new IntelligenceService({ ...(restarted.service as any).deps, repo: h.repo });
    const timers = { setTimeout: () => 1, clearTimeout: () => {} };
    const scheduler = new IntelligenceScheduler(service, { now: () => new Date(local(12, 0)), timers });

    scheduler.start();
    const cycle = await scheduler.runCycle();
    scheduler.stop();

    expect(h.repo.runs.find((r) => r.id === 'crashed')).toMatchObject({ status: 'failed', errorCategory: 'internal' });
    expect(cycle.results).toHaveLength(1);
    expect(cycle.results[0].status).toBe('succeeded');
    expect(h.repo.active()).toHaveLength(1);
    expect(restarted.gemini.requests).toHaveLength(1);
  });

  it('stops the cycle on an outage and retries the same window next cycle', async () => {
    const { h, output } = shutdownScenario();
    h.events.events.push(makeEvent(3, local(10, 30), local(10, 50), { app: 'Figma', title: 'Mock' }));
    const offline = () => new GeminiError('network', 'offline', true);
    const scripted = makeHarness(h.events.events, [offline(), offline(), offline()]);
    scripted.setNow(local(12, 0));

    const first = await scripted.service.processBacklog();

    expect(first).toMatchObject({ status: 'stopped', reason: 'network', windowsConsidered: 1 });
    expect(scripted.gemini.requests).toHaveLength(3); // the 10:00 window was not attempted

    scripted.gemini.push(
      output(),
      modelOutput([modelActivity({ eventIds: [3], startedAt: local(10, 30), endedAt: local(10, 50) })], [], [local(10), local(11)]),
    );
    const second = await scripted.service.processBacklog();

    expect(second.results.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('gives up on a window whose output keeps being rejected', async () => {
    const { h } = shutdownScenario();
    const garbage = makeHarness(h.events.events, Array(9).fill('not json'));
    garbage.setNow(local(12, 0));

    for (let i = 0; i < 3; i++) await garbage.service.processBacklog();
    const fourth = await garbage.service.processBacklog();

    expect(garbage.gemini.requests).toHaveLength(9); // 3 cycles × 3 attempts, then no more
    expect(fourth).toMatchObject({ status: 'completed', windowsConsidered: 0 });
  });

  it('analyzeRecent analyses the last 60 minutes through the same pipeline', async () => {
    const events = [makeEvent(1, t('11:10'), t('11:50'), { app: 'VS Code', title: 'a.ts - reflect' })];
    const h = makeHarness(events, [
      modelOutput([modelActivity({ eventIds: [1], startedAt: t('11:10'), endedAt: t('11:50') })], [], [t('11:00'), t('12:00')]),
    ]);

    const result = await h.service.analyzeRecent();

    expect(result).toMatchObject({ status: 'succeeded', windowStart: t('11:00'), windowEnd: t('12:00') });
    expect(h.service.getStatus()).toMatchObject({ configured: true, model: 'test-model' });
    expect(h.service.getStatus().recentRuns[0]).not.toHaveProperty('outputJson');
  });
});
