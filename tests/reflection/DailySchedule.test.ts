import { describe, it, expect, vi } from 'vitest';
import type { GenerateResult, ReflectionPeriod } from '../../src/reflection/ReflectionModels';
import { periodContaining } from '../../src/reflection/ReflectionPeriods';
import { ReflectionScheduler } from '../../src/reflection/ReflectionScheduler';
import { dailyReflectionTimeLabel } from '../../src/ui/Reflection/reflectionView';
import { iso, local, makeReflectionHarness, modelReflection, projectX, seedThreads, workday, type HarnessOptions } from './helpers';

/**
 * When the day's reflection is written: at the user's own reflection time, or
 * a little earlier once the day has visibly wound down — never assuming that
 * 10 PM or midnight is right for everyone.
 */
const today = periodContaining('day', local(19));

function harness(options: HarnessOptions = {}) {
  const h = makeReflectionHarness({
    activities: [...[5, 6, 7, 8, 9, 12, 13, 14, 15, 16].flatMap(workday), ...workday(19)],
    now: local(19, '17:00'),
    ...options,
  });
  seedThreads(h.repo, h.activities);
  const due = async () => (await h.service.pendingScheduledPeriods()).some((p) => p.type === 'day' && p.key === today.key);
  return { ...h, due };
}

describe('daily reflection time', () => {
  it('follows the user\'s configured time', async () => {
    const h = harness({ reflectionMinutes: 18 * 60 + 30, activities: [...[5, 6, 7, 8, 9].flatMap(workday), ...workday(19), projectX(19, '17:30', 55)] });
    seedThreads(h.repo, h.activities);
    h.setNow(local(19, '18:20')); // still working: 5 minutes ago
    expect(await h.due()).toBe(false);
    h.setNow(local(19, '18:32'));
    expect(await h.due()).toBe(true);
    expect(h.service.nextDailyReflectionAt().toISOString()).toBe(iso(20, '18:30'));
  });

  it('tells the view when today\'s reflection is written', async () => {
    const h = harness({ reflectionMinutes: 21 * 60 + 15 });
    const view = await h.service.getView('day', null);
    expect(view.dailyReflectionAt).toBe(iso(19, '21:15'));
    expect(dailyReflectionTimeLabel(view)).toBe('9:15 PM');
    expect((await h.service.getView('day', iso(16, '12:00'))).dailyReflectionAt).toBeNull();
    expect((await h.service.getView('week', null)).dailyReflectionAt).toBeNull();
    // Without a view, the label falls back to the default.
    expect(dailyReflectionTimeLabel(null)).toBe('10:00 PM');
  });

  it('writes early once the day has wound down — but not before the early window', async () => {
    const h = harness(); // default: 10 PM; the working day ended at 3:28 PM
    h.setNow(local(19, '19:30'));
    expect(await h.due()).toBe(false); // more than two hours early
    h.setNow(local(19, '20:05'));
    expect(await h.due()).toBe(true); // nothing tracked for hours
  });

  it('does not write early while the user is still at it', async () => {
    const h = harness({ activities: [...[5, 6, 7, 8, 9].flatMap(workday), ...workday(19), projectX(19, '19:10', 70)] });
    seedThreads(h.repo, h.activities);
    h.setNow(local(19, '20:30')); // worked until 8:20 PM
    expect(await h.due()).toBe(false);
    h.setNow(local(19, '21:05')); // 45 quiet minutes later
    expect(await h.due()).toBe(true);
  });

  it('does not write early about a day with almost nothing in it', async () => {
    const h = harness({ activities: [...[5, 6, 7, 8, 9].flatMap(workday), projectX(19, '09:00', 12)] });
    seedThreads(h.repo, h.activities);
    h.setNow(local(19, '20:30'));
    expect(await h.due()).toBe(false);
  });

  it('an early reflection is not rewritten at the reflection time', async () => {
    const h = harness();
    h.setNow(local(19, '20:05'));
    h.gemini.push(modelReflection(today));
    await h.service.generate(today, { trigger: 'scheduled' });
    h.setNow(local(19, '22:02'));
    expect(await h.due()).toBe(false);
  });
});

describe('landing content', () => {
  it('opens on today when today has a reflection', async () => {
    const h = harness({ now: local(19, '22:05') });
    h.gemini.push(modelReflection(today));
    await h.service.generate(today, { trigger: 'scheduled' });
    expect(h.service.landingAnchor()).toBeNull();
  });

  it('otherwise opens on the latest day that has one — a morning opens on yesterday\'s briefing', async () => {
    const h = harness({ now: local(16, '22:05') });
    const friday = periodContaining('day', local(16));
    h.gemini.push(modelReflection(friday));
    await h.service.generate(friday, { trigger: 'scheduled' });

    h.setNow(local(17, '08:00')); // Saturday morning
    expect(h.service.landingAnchor()).toBe(friday.start);
    h.setNow(local(19, '08:00')); // Monday morning, three days later
    expect(h.service.landingAnchor()).toBe(friday.start);
    h.setNow(local(21, '08:00')); // too long ago to be "the latest briefing"
    expect(h.service.landingAnchor()).toBeNull();
  });

  it('opens on today when nothing has been written yet', () => {
    expect(harness().service.landingAnchor()).toBeNull();
  });
});

describe('ReflectionScheduler — end-of-day wake-up', () => {
  function fakeTimers() {
    const pending: { fn: () => void; ms: number; handle: number }[] = [];
    let next = 1;
    return {
      pending,
      timers: {
        setTimeout: (fn: () => void, ms: number) => {
          const handle = next++;
          pending.push({ fn, ms, handle });
          return handle;
        },
        clearTimeout: (handle: unknown) => {
          const index = pending.findIndex((t) => t.handle === handle);
          if (index >= 0) pending.splice(index, 1);
        },
      },
    };
  }

  function fakeService(dueAt: () => Date) {
    return {
      isConfigured: vi.fn(() => true),
      recoverInterrupted: vi.fn(() => 0),
      pendingScheduledPeriods: vi.fn(async (): Promise<ReflectionPeriod[]> => []),
      generate: vi.fn(async (period: ReflectionPeriod): Promise<GenerateResult> => ({ status: 'skipped', reason: 'no_data', period })),
      nextDailyReflectionAt: vi.fn(dueAt),
    };
  }

  it('wakes just after the reflection time, asks for a cycle, and arms itself for the next day', () => {
    let now = local(19, '17:00');
    let due = local(19, '22:00');
    const { pending, timers } = fakeTimers();
    const onDue = vi.fn();
    const scheduler = new ReflectionScheduler(fakeService(() => due), { now: () => now, timers, onDailyReflectionDue: onDue });

    expect(pending).toEqual([]);
    scheduler.start();
    expect(pending).toHaveLength(1);
    expect(pending[0].ms).toBe(5 * 3_600_000 + 30_000);

    now = local(19, '22:00');
    due = local(20, '22:00');
    pending.shift()!.fn();
    expect(onDue).toHaveBeenCalledTimes(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].ms).toBe(24 * 3_600_000 + 30_000);
  });

  it('runs a cycle itself when the host gives it nothing else to do', async () => {
    const { pending, timers } = fakeTimers();
    const service = fakeService(() => local(19, '22:00'));
    const scheduler = new ReflectionScheduler(service, { now: () => local(19, '21:59'), timers });
    scheduler.start();
    pending.shift()!.fn();
    await Promise.resolve();
    expect(service.pendingScheduledPeriods).toHaveBeenCalledTimes(1);
  });

  it('re-aims the wake-up when the reflection time changes, and stops cleanly', () => {
    let due = local(19, '22:00');
    const { pending, timers } = fakeTimers();
    const scheduler = new ReflectionScheduler(fakeService(() => due), { now: () => local(19, '17:00'), timers });
    scheduler.reschedule(); // not started: nothing to aim
    expect(pending).toEqual([]);

    scheduler.start();
    due = local(19, '18:00');
    scheduler.reschedule();
    expect(pending).toHaveLength(1);
    expect(pending[0].ms).toBe(3_600_000 + 30_000);

    scheduler.stop();
    expect(pending).toEqual([]);
  });

  it('never spins: a time that has just passed waits at least a minute', () => {
    const { pending, timers } = fakeTimers();
    const scheduler = new ReflectionScheduler(fakeService(() => local(19, '21:59')), { now: () => local(19, '22:00'), timers });
    scheduler.start();
    expect(pending[0].ms).toBe(60_000);
  });

  it('passes what was generated to the host', async () => {
    const period = periodContaining('day', local(19));
    const service = {
      isConfigured: () => true,
      recoverInterrupted: () => 0,
      pendingScheduledPeriods: async () => [period],
      generate: async (): Promise<GenerateResult> => ({ status: 'succeeded', reportId: 'r1', period, attempts: 1, insightCount: 2 }),
    };
    const onGenerated = vi.fn();
    const scheduler = new ReflectionScheduler(service, { onGenerated });
    scheduler.start(); // no reflection time on this service: no timer, and no crash
    await scheduler.runCycle();
    expect(onGenerated).toHaveBeenCalledWith([{ status: 'succeeded', reportId: 'r1', period, attempts: 1, insightCount: 2 }]);
  });
});
