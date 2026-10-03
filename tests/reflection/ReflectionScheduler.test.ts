import { describe, it, expect, vi } from 'vitest';
import { IntelligenceScheduler } from '../../src/intelligence/IntelligenceScheduler';
import type { BacklogResult } from '../../src/intelligence/IntelligenceModels';
import { GeminiError } from '../../src/intelligence/GeminiClient';
import type { GenerateResult, ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionScheduler } from '../../src/reflection/ReflectionScheduler';
import { local, makeReflectionHarness, modelReflection, seedThreads, workday } from './helpers';

const day = (d: number) => periodContaining('day', local(d));
const week = (d: number) => periodContaining('week', local(d));

const succeeded = (period: ReflectionPeriod): GenerateResult => ({
  status: 'succeeded',
  reportId: `r-${period.key}`,
  period,
  attempts: 1,
  insightCount: 2,
});

function fakeService(pending: ReflectionPeriod[], outcome: (p: ReflectionPeriod) => GenerateResult = succeeded) {
  return {
    isConfigured: vi.fn(() => true),
    recoverInterrupted: vi.fn(() => 0),
    pendingScheduledPeriods: vi.fn(async () => pending),
    generate: vi.fn(async (period: ReflectionPeriod) => outcome(period)),
  };
}

describe('ReflectionScheduler', () => {
  it('recovers interrupted generations on start and does nothing before it', async () => {
    const service = fakeService([day(16)]);
    const scheduler = new ReflectionScheduler(service);
    expect(await scheduler.runCycle()).toMatchObject({ status: 'stopped', reason: 'not_started' });
    expect(service.generate).not.toHaveBeenCalled();

    scheduler.start();
    scheduler.start(); // idempotent
    expect(service.recoverInterrupted).toHaveBeenCalledTimes(1);
  });

  it('generates every due report in order, as scheduled reports', async () => {
    const service = fakeService([day(16), week(14)]);
    const onGenerated = vi.fn();
    const scheduler = new ReflectionScheduler(service, { onGenerated });
    scheduler.start();

    const result = await scheduler.runCycle();
    expect(result.status).toBe('completed');
    expect(service.generate.mock.calls.map(([period, options]) => [period.key, options])).toEqual([
      ['2026-10-16', { trigger: 'scheduled' }],
      ['2026-W42', { trigger: 'scheduled' }],
    ]);
    expect(onGenerated).toHaveBeenCalledTimes(1);
  });

  it('is unavailable — and writes nothing — without Gemini', async () => {
    const service = fakeService([day(16)]);
    service.isConfigured.mockReturnValue(false);
    const scheduler = new ReflectionScheduler(service);
    scheduler.start();
    expect(await scheduler.runCycle()).toEqual({ status: 'unavailable', reason: 'missing_api_key', results: [] });
    expect(service.pendingScheduledPeriods).not.toHaveBeenCalled();
  });

  it('stops the cycle on a failure that would hit every other report too', async () => {
    const service = fakeService([day(16), day(17), week(14)], (period) =>
      period.key === '2026-10-17'
        ? { status: 'failed', category: 'quota', error: '429', reportId: 'x', period, attempts: 3 }
        : succeeded(period),
    );
    const onGenerated = vi.fn();
    const scheduler = new ReflectionScheduler(service, { onGenerated });
    scheduler.start();

    const result = await scheduler.runCycle();
    expect(result).toMatchObject({ status: 'stopped', reason: 'quota' });
    expect(service.generate).toHaveBeenCalledTimes(2); // the week waits for the next cycle
    expect(onGenerated).toHaveBeenCalledTimes(1); // the first report still landed
  });

  it('continues past a report whose output was rejected', async () => {
    const service = fakeService([day(16), week(14)], (period) =>
      period.type === 'day'
        ? { status: 'failed', category: 'validation', error: 'bad', reportId: 'x', period, attempts: 3 }
        : succeeded(period),
    );
    const scheduler = new ReflectionScheduler(service);
    scheduler.start();
    expect((await scheduler.runCycle()).status).toBe('completed');
    expect(service.generate).toHaveBeenCalledTimes(2);
  });

  it('overlapping cycles share the in-flight one', async () => {
    let release!: () => void;
    const service = fakeService([day(16)]);
    service.generate.mockImplementation(
      (period: ReflectionPeriod) => new Promise<GenerateResult>((resolve) => (release = () => resolve(succeeded(period)))),
    );
    const scheduler = new ReflectionScheduler(service);
    scheduler.start();

    const first = scheduler.runCycle();
    const second = scheduler.runCycle();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    release();
    await first;
    expect(service.generate).toHaveBeenCalledTimes(1);
  });

  it('a planning error never escapes the cycle', async () => {
    const service = fakeService([]);
    service.pendingScheduledPeriods.mockRejectedValue(new Error('db locked'));
    const scheduler = new ReflectionScheduler(service);
    scheduler.start();
    expect(await scheduler.runCycle()).toEqual({ status: 'stopped', reason: 'internal', results: [] });
  });

  it('runs right behind every intelligence cycle (no timer of its own)', async () => {
    const backlog: BacklogResult = { status: 'completed', windowsConsidered: 0, results: [] };
    const intelligence = { recoverInterruptedRuns: vi.fn(() => 0), processBacklog: vi.fn(async () => backlog) };
    const service = fakeService([day(16)]);
    const reflection = new ReflectionScheduler(service);
    const timers = { setTimeout: vi.fn(() => 1), clearTimeout: vi.fn() };
    const scheduler = new IntelligenceScheduler(intelligence, {
      timers,
      now: () => local(19, '09:00'),
      onCycleComplete: () => void reflection.runCycle(),
    });

    reflection.start();
    scheduler.start();
    await scheduler.runCycle();
    await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
    // Also after a cycle in which nothing new was analysed, or Gemini was down.
    intelligence.processBacklog.mockResolvedValue({ status: 'unavailable', reason: 'missing_api_key', windowsConsidered: 0, results: [] });
    await scheduler.runCycle();
    await vi.waitFor(() => expect(service.pendingScheduledPeriods).toHaveBeenCalledTimes(2));
    scheduler.stop();
  });
});

/** The scheduler driving the real service: the "generated once" guarantees. */
describe('ReflectionScheduler + ReflectionService', () => {
  const TWO_WEEKS = [5, 6, 7, 8, 9, 12, 13, 14, 15, 16];

  function setup(now = local(19, '09:00'), days = TWO_WEEKS) {
    const h = makeReflectionHarness({ activities: days.flatMap(workday), now });
    seedThreads(h.repo, h.activities);
    const scheduler = new ReflectionScheduler(h.service);
    scheduler.start();
    /** Script one valid reflection per period that will be generated. */
    const script = (...periods: ReflectionPeriod[]) => periods.forEach((p) => h.gemini.push(modelReflection(p)));
    return { ...h, scheduler, script };
  }

  it('on startup, generates the backlog of closed periods — each exactly once', async () => {
    const h = setup();
    // Sat/Sun hold no activity: they are examined, found empty, and not asked about again.
    h.script(day(16), week(7), week(14));

    const first = await h.scheduler.runCycle();
    expect(first.results.map((r) => `${r.period.type}:${r.period.key}:${r.status}`)).toEqual([
      'day:2026-10-16:succeeded',
      'day:2026-10-17:skipped',
      'day:2026-10-18:skipped',
      'week:2026-W41:succeeded',
      'week:2026-W42:succeeded',
    ]);
    expect(h.gemini.requests).toHaveLength(3);

    // The next cycles find nothing left to do: no second report, no model call.
    for (let i = 0; i < 3; i++) expect((await h.scheduler.runCycle()).results).toEqual([]);
    expect(h.gemini.requests).toHaveLength(3);
    expect(h.repo.listCurrentReports('week', 10)).toHaveLength(2);
    expect(h.repo.listCurrentReports('day', 10)).toHaveLength(1);
  });

  it('generates the closed day, week and month when each closes', async () => {
    const h = setup(local(16, '23:30')); // Friday night: nothing has closed since Thursday
    h.script(day(13), day(14), day(15), week(7), day(16));
    await h.scheduler.runCycle(); // backlog (Tue–Thu, last week) + tonight's reflection of Friday
    expect(h.repo.getCurrentReport('day', '2026-10-16')).not.toBeNull();
    const calls = h.gemini.requests.length;

    // Monday 00:02 — the week of Oct 12 has closed.
    h.setNow(local(19, '00:02'));
    h.script(week(14));
    const afterWeek = await h.scheduler.runCycle();
    expect(afterWeek.results.filter((r) => r.status === 'succeeded').map((r) => r.period.key)).toEqual(['2026-W42']);
    expect(h.gemini.requests.length).toBe(calls + 1);

    // Sunday Nov 1, 00:02 — October has closed.
    h.setNow(local(32, '00:02'));
    const october = periodContaining('month', local(15));
    h.script(october);
    const afterMonth = await h.scheduler.runCycle();
    expect(afterMonth.results.filter((r) => r.status === 'succeeded').map((r) => r.period.key)).toEqual(['2026-10']);
    expect(h.repo.getCurrentReport('month', '2026-10')!.coveredUntil).toBe(october.end);
    expect((await h.scheduler.runCycle()).results.filter((r) => r.status === 'succeeded')).toEqual([]);
  });

  it('generates the closed year once the year turns', async () => {
    // Four working weeks in October; a year needs activity on at least 20 days.
    const h = setup(new Date(2027, 0, 1, 0, 2), [...TWO_WEEKS, 19, 20, 21, 22, 23, 26, 27, 28, 29, 30]);
    const year = periodContaining('year', local(15));
    h.script(year);

    const result = await h.scheduler.runCycle();
    expect(result.results.filter((r) => r.status === 'succeeded').map((r) => `${r.period.type}:${r.period.key}`)).toEqual(['year:2026']);
    expect(h.gemini.requests[0].prompt).toContain('what trajectory am I actually building?');
    expect(h.repo.getCurrentReport('year', '2026')!.metricsSnapshot!['series.2026-10.tracked_minutes'].display).toBe('90h 40m');

    expect((await h.scheduler.runCycle()).results.filter((r) => r.period.type === 'year')).toEqual([]);
  });

  it('a failed report is retried on a later cycle', async () => {
    const h = setup();
    const offline = new GeminiError('network', 'offline', true);
    h.gemini.push(offline, offline, offline);
    const failed = await h.scheduler.runCycle();
    expect(failed).toMatchObject({ status: 'stopped', reason: 'network' });
    expect(h.repo.listCurrentReports(null, 10)).toEqual([]);

    h.script(day(16), week(7), week(14));
    const retried = await h.scheduler.runCycle();
    expect(retried.status).toBe('completed');
    expect(h.repo.listCurrentReports(null, 10)).toHaveLength(3);
  });
});
