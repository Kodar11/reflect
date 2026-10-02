import { describe, it, expect, vi } from 'vitest';
import { IntelligenceScheduler } from '../../src/intelligence/IntelligenceScheduler';
import type { BacklogResult } from '../../src/intelligence/IntelligenceModels';

function makeTimers() {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const entry = { fn, ms };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      const i = pending.indexOf(handle as { fn: () => void; ms: number });
      if (i >= 0) pending.splice(i, 1);
    },
    fire() {
      pending.shift()!.fn();
    },
  };
}

const done = (results: BacklogResult['results'] = []): BacklogResult => ({
  status: 'completed',
  windowsConsidered: results.length,
  results,
});

describe('IntelligenceScheduler', () => {
  it('recovers interrupted runs and processes the backlog on start without blocking', () => {
    let resolve!: (r: BacklogResult) => void;
    const service = {
      recoverInterruptedRuns: vi.fn(() => 0),
      processBacklog: vi.fn(() => new Promise<BacklogResult>((r) => { resolve = r; })),
    };
    const timers = makeTimers();
    const scheduler = new IntelligenceScheduler(service, { timers, now: () => new Date(2026, 2, 2, 12, 0, 0) });

    scheduler.start(); // returns immediately although the backlog is still running

    expect(service.recoverInterruptedRuns).toHaveBeenCalledTimes(1);
    expect(service.processBacklog).toHaveBeenCalledTimes(1);
    expect(timers.pending).toHaveLength(1);
    resolve(done());
    scheduler.stop();
  });

  it('wakes shortly after each hour boundary and re-arms itself', async () => {
    const service = { recoverInterruptedRuns: vi.fn(() => 0), processBacklog: vi.fn(async () => done()) };
    const timers = makeTimers();
    let now = new Date(2026, 2, 2, 12, 40, 0);
    const scheduler = new IntelligenceScheduler(service, { timers, now: () => now });

    scheduler.start();
    await scheduler.runCycle();
    expect(timers.pending[0].ms).toBe(22 * 60_000); // 13:02

    now = new Date(2026, 2, 2, 13, 2, 0);
    timers.fire();
    await scheduler.runCycle();

    expect(service.processBacklog).toHaveBeenCalledTimes(2);
    expect(timers.pending).toHaveLength(1);
    expect(timers.pending[0].ms).toBe(60 * 60_000); // 14:02
    scheduler.stop();
    expect(timers.pending).toHaveLength(0);
  });

  it('never runs two cycles at once', async () => {
    let resolve!: (r: BacklogResult) => void;
    const service = {
      recoverInterruptedRuns: vi.fn(() => 0),
      processBacklog: vi.fn(() => new Promise<BacklogResult>((r) => { resolve = r; })),
    };
    const scheduler = new IntelligenceScheduler(service, { timers: makeTimers() });

    const a = scheduler.runCycle();
    const b = scheduler.runCycle();
    resolve(done());

    expect(await a).toBe(await b);
    expect(service.processBacklog).toHaveBeenCalledTimes(1);
  });

  it('survives a failing cycle and notifies only when something was analysed', async () => {
    const onAnalyzed = vi.fn();
    const service = {
      recoverInterruptedRuns: vi.fn(() => 0),
      processBacklog: vi
        .fn<() => Promise<BacklogResult>>()
        .mockRejectedValueOnce(new Error('unexpected'))
        .mockResolvedValueOnce(done())
        .mockResolvedValueOnce(
          done([{ status: 'succeeded', runId: 'r', windowStart: 'a', windowEnd: 'b', attempts: 1, eventCount: 2, activitiesCreated: 1, activitiesExtended: 0 }]),
        ),
    };
    const scheduler = new IntelligenceScheduler(service, { timers: makeTimers(), onAnalyzed });

    expect(await scheduler.runCycle()).toMatchObject({ status: 'stopped', reason: 'internal' });
    await scheduler.runCycle();
    expect(onAnalyzed).not.toHaveBeenCalled();
    await scheduler.runCycle();
    expect(onAnalyzed).toHaveBeenCalledTimes(1);
  });
});
