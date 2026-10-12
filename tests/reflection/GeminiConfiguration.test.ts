import { describe, it, expect } from 'vitest';
import { GeminiClient, GeminiError } from '../../src/intelligence/GeminiClient';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionScheduler } from '../../src/reflection/ReflectionScheduler';
import { iso, local, makeReflectionHarness, modelInsight, modelReflection, seedThreads, workday } from './helpers';

/**
 * Reflection against the Gemini configuration: no key, a key Gemini refuses,
 * a model the key cannot use, an outage — each told apart, none of them
 * costing a reflection that already exists, and all of them recoverable.
 *
 * Two full working weeks (Oct 5–9, Oct 12–16); "now" is Mon Oct 19, 09:00.
 */
const week42 = periodContaining('week', local(14));

function harness() {
  const h = makeReflectionHarness({
    activities: [5, 6, 7, 8, 9, 12, 13, 14, 15, 16].flatMap(workday),
    now: local(19, '09:00'),
    priorities: ['Launching Project X'],
  });
  const priorities = h.service.syncPriorities();
  seedThreads(h.repo, h.activities, { 'Project X': priorities[0]?.id ?? 'none' });
  return h;
}

const weekly = () =>
  modelReflection(week42, {
    headline: 'Project X received consistent attention this week.',
    insights: [
      modelInsight({
        type: 'progress',
        title: 'Project X moved forward on 5 days',
        observation: 'You spent 14h 20m on Project X across 5 days.',
        interpretation: 'It was your most consistently worked thread.',
        metricKeys: ['thread.project-x.minutes', 'thread.project-x.active_days'],
      }),
    ],
    carryForward: {
      text: 'Keep a morning block for Project X before switching threads.',
      sourceMetricKeys: ['pattern.longest_block_before_noon_days'],
      sourceActivityRefs: [],
    },
  });

const refused = () => new GeminiError('invalid_api_key', 'Gemini did not accept the API key (400): API key not valid.', false, 400);
const noModel = () => new GeminiError('model_unavailable', 'Gemini model unavailable (404) — set GEMINI_MODEL to a model this key can use: not found', false, 404);
const offline = () => new GeminiError('network', 'Gemini network error: fetch failed', true);

describe('Reflection — Gemini is not configured', () => {
  it('says so, writes nothing, and keeps the measured numbers', async () => {
    const h = harness();
    h.gemini.configured = false;

    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'missing_api_key', reportId: null, attempts: 0 });
    expect(h.gemini.requests).toHaveLength(0);
    // Nothing is recorded: no failed report is left behind to recover from.
    expect(h.repo.reports).toEqual([]);

    const view = await h.service.getView('week', iso(14));
    expect(view).toMatchObject({ configured: false, report: null, canRefresh: false, refreshBlockedReason: 'not_configured' });
    expect(view.generation).toMatchObject({ state: 'idle', errorCategory: null });
    expect(view.live!.metrics[0]).toEqual({ key: 'time.tracked_minutes', label: 'Total tracked time', display: '22h 40m' });
  });

  it('once a key is configured, the same period is written — complete and validated', async () => {
    const h = harness();
    h.gemini.configured = false;
    await h.service.generate(week42, { trigger: 'manual' });

    h.gemini.configured = true;
    let view = await h.service.getView('week', iso(14));
    expect(view).toMatchObject({ configured: true, canRefresh: true, refreshBlockedReason: null });

    h.gemini.push(weekly());
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'succeeded', attempts: 1, insightCount: 1 });
    view = await h.service.getView('week', iso(14));
    expect(view.report).toMatchObject({
      status: 'fresh',
      headline: 'Project X received consistent attention this week.',
      carryForward: { text: 'Keep a morning block for Project X before switching threads.' },
    });
    expect(view.report!.insights).toHaveLength(1);
    expect(view.report!.insights[0].evidence.length).toBeGreaterThan(0);
    expect(view.report!.supportingMetrics.length).toBeGreaterThan(0);
    expect(view.generation.state).toBe('idle');
    expect(h.repo.reports).toHaveLength(1);
  });
});

describe('Reflection — Gemini is configured but the request fails', () => {
  it('a refused key is an invalid key, not a missing one, and is not retried', async () => {
    const h = harness();
    h.gemini.push(refused());

    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'invalid_api_key', attempts: 1 });
    expect(h.sleeps).toEqual([]);

    const view = await h.service.getView('week', iso(14));
    expect(view.configured).toBe(true);
    expect(view.report).toBeNull();
    expect(view.generation).toMatchObject({
      state: 'failed',
      errorCategory: 'invalid_api_key',
      message: 'Gemini did not accept the API key. Check the key in Settings. Nothing was changed.',
    });
    expect(view.live!.metrics.length).toBeGreaterThan(0);
  });

  it('a model the key cannot use is reported as that', async () => {
    const h = harness();
    h.gemini.push(noModel());
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'model_unavailable', attempts: 1 });
    const view = await h.service.getView('week', iso(14));
    expect(view.generation).toMatchObject({
      state: 'failed',
      errorCategory: 'model_unavailable',
      message: 'The configured Gemini model is not available for this API key. Nothing was changed.',
    });
  });

  it('an outage is an outage: never reported as a missing or invalid key', async () => {
    for (const [error, category] of [
      [offline(), 'network'],
      [new GeminiError('api', 'Gemini API error (503): UNAVAILABLE', true, 503), 'api'],
      [new GeminiError('quota', 'Gemini quota/rate limit (429)', true, 429), 'quota'],
    ] as const) {
      const h = harness();
      h.gemini.push(error, error, error);
      expect(await h.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({ status: 'failed', category });
      const view = await h.service.getView('week', iso(14));
      expect(view.configured).toBe(true);
      expect(view.refreshBlockedReason).not.toBe('not_configured');
      expect(view.generation.errorCategory).toBe(category);
      expect(view.generation.message).not.toMatch(/not configured|API key/i);
    }
  });

  it('a failed regeneration leaves the existing reflection exactly as it was', async () => {
    const h = harness();
    h.gemini.push(weekly());
    await h.service.generate(week42, { trigger: 'scheduled' });
    const before = structuredClone(h.repo.getCurrentReport('week', week42.key)!);
    h.repo.markStale(before.id, 'activity_changed', iso(19));

    for (const error of [refused(), noModel()]) {
      h.gemini.push(error);
      expect((await h.service.generate(week42, { trigger: 'scheduled' })).status).toBe('failed');
      const current = h.repo.getCurrentReport('week', week42.key)!;
      expect(current.id).toBe(before.id);
      expect(current.headline).toBe(before.headline);
      expect(current.insights).toEqual(before.insights);
    }

    // The key is removed altogether: the reflection is still there to read.
    h.gemini.configured = false;
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'failed', category: 'missing_api_key' });
    const view = await h.service.getView('week', iso(14));
    expect(view.report).toMatchObject({ id: before.id, headline: before.headline });
    expect(view.configured).toBe(false);
  });
});

describe('Reflection — recovering after the configuration is corrected', () => {
  it('a period that failed on a refused key is retried and written once', async () => {
    const h = harness();
    h.gemini.push(refused());
    await h.service.generate(week42, { trigger: 'scheduled' });

    // Not written off: the scheduler still wants it.
    expect((await h.service.pendingScheduledPeriods()).some((p) => p.type === 'week' && p.key === week42.key)).toBe(true);

    h.gemini.push(weekly());
    expect(await h.service.generate(week42, { trigger: 'scheduled' })).toMatchObject({ status: 'succeeded' });

    const view = await h.service.getView('week', iso(14));
    expect(view.report!.headline).toBe('Project X received consistent attention this week.');
    expect(view.generation).toMatchObject({ state: 'idle', errorCategory: null });
    // One report, no duplicate — and the failed attempt is not left behind as a stale error.
    const forWeek = h.repo.reports.filter((r) => r.period.type === 'week' && r.period.key === week42.key);
    expect(forWeek.map((r) => r.status)).toEqual(['fresh']);
    expect(h.repo.getLatestAttempt('week', week42.key)).toMatchObject({ status: 'fresh', errorCategory: null });
    expect((await h.service.pendingScheduledPeriods()).some((p) => p.type === 'week' && p.key === week42.key)).toBe(false);
  });

  it('a manual retry follows the ordinary lifecycle: a short wait after a failure, then it works', async () => {
    const h = harness();
    h.gemini.push(refused());
    await h.service.generate(week42, { trigger: 'manual' });

    let view = await h.service.getView('week', iso(14));
    expect(view).toMatchObject({ canRefresh: false, refreshBlockedReason: 'cooldown' });
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'skipped', reason: 'throttled' });
    expect(h.gemini.requests).toHaveLength(1);

    h.setNow(local(19, '09:02'));
    view = await h.service.getView('week', iso(14));
    expect(view.canRefresh).toBe(true);
    h.gemini.push(weekly());
    expect(await h.service.generate(week42, { trigger: 'manual' })).toMatchObject({ status: 'succeeded' });
  });

  it('the scheduler stops a cycle on a refused key instead of repeating the request for every period', async () => {
    const h = harness();
    const scheduler = new ReflectionScheduler(h.service);
    scheduler.start();
    h.gemini.push(refused());
    const cycle = await scheduler.runCycle();
    scheduler.stop();
    expect(cycle).toMatchObject({ status: 'stopped', reason: 'invalid_api_key' });
    expect(h.gemini.requests).toHaveLength(1);
  });

  it('without a key the scheduler does nothing at all', async () => {
    const h = harness();
    h.gemini.configured = false;
    const scheduler = new ReflectionScheduler(h.service);
    scheduler.start();
    expect(await scheduler.runCycle()).toMatchObject({ status: 'unavailable', reason: 'missing_api_key', results: [] });
    scheduler.stop();
    expect(h.repo.reports).toEqual([]);
  });
});

describe('Reflection — the key stays out of everything that is stored or shown', () => {
  it('a provider error that echoes the key reaches neither the result, the view nor the database', async () => {
    const KEY = 'test-key-not-real-0123456789';
    // The error as the real client produces it from a provider message that contains the key.
    const client = new GeminiClient({
      getApiKey: () => KEY,
      createTransport: () => ({
        generateContent: async () => {
          throw Object.assign(new Error(`API key not valid: ${KEY} (https://example.test/v1?key=${KEY})`), { status: 400 });
        },
      }),
    });
    const error = await client.generateJson({ systemInstruction: 's', prompt: 'p', responseJsonSchema: {} }).catch((e) => e as GeminiError);
    expect(error).toMatchObject({ category: 'invalid_api_key' });

    const h = harness();
    h.gemini.push(error);
    const result = await h.service.generate(week42, { trigger: 'manual' });
    const view = await h.service.getView('week', iso(14));
    const everything = JSON.stringify({ result, view, stored: h.repo.reports });
    expect(everything).not.toContain(KEY);
    expect(everything).toContain('[REDACTED]');
  });
});
