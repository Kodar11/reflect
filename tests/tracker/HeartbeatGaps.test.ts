import { describe, it, expect } from 'vitest';
import { HeartbeatEngine } from '../../src/tracker/HeartbeatEngine';
import { TrackingService } from '../../src/tracker/TrackingService';
import { FakeEventRepository } from './FakeEventRepository';
import type { IWatcher } from '../../src/tracker/watcher/IWatcher';

/**
 * Unobserved time is never tracked time. Reflect now runs all day in the
 * background, so the machine sleeping, hibernating or freezing between two
 * heartbeats must not stretch the open event across the gap — and a stop
 * (pause, quit) must end what was open.
 */

const at = (h: number, m = 0, s = 0) => new Date(2026, 0, 5, h, m, s);
const MAX_GAP = 30_000;

function setup() {
  const repo = new FakeEventRepository();
  let clock = at(9);
  const engine = new HeartbeatEngine(repo, () => clock, 5000, undefined, MAX_GAP);
  engine.start();
  return {
    repo,
    engine,
    setNow: (d: Date) => {
      clock = d;
    },
    sample: (app = 'Code') => engine.emit({ watcher: 'window', app, title: app }),
  };
}

const durations = (repo: FakeEventRepository) =>
  repo.getAll().map((e) => Date.parse(e.endedAt) - Date.parse(e.startedAt));

describe('HeartbeatEngine — gaps in observation', () => {
  it('keeps merging while the heartbeat is continuous', () => {
    const t = setup();
    t.sample();
    for (let s = 5; s <= 120; s += 5) {
      t.setNow(at(9, 0, s));
      t.engine.flush();
      t.sample();
    }
    expect(t.repo.inserts).toHaveLength(1);
    expect(t.repo.getAll()[0].endedAt).toBe(at(9, 2, 0).toISOString());
    t.engine.stop();
  });

  it('no fake activity during sleep: a flush after a long silence ends the event where it was last seen', () => {
    const t = setup();
    t.sample();
    t.setNow(at(9, 0, 10));
    t.engine.flush(); // last heartbeat before the lid closed

    t.setNow(at(17)); // eight hours later the flush timer fires again
    t.engine.flush();

    const [event] = t.repo.getAll();
    expect(event.endedAt).toBe(at(9, 0, 10).toISOString());
    expect(t.engine.openCount).toBe(0);
    t.engine.stop();
  });

  it('the first sample after a gap opens a new event instead of extending the old one', () => {
    const t = setup();
    t.sample('Code');
    t.setNow(at(9, 0, 10));
    t.sample('Code');

    t.setNow(at(13)); // woke up with the same window still in front
    t.sample('Code');

    const events = t.repo.getAll();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ startedAt: at(9).toISOString(), endedAt: at(9, 0, 10).toISOString() });
    expect(events[1].startedAt).toBe(at(13).toISOString());
    expect(durations(t.repo)).toEqual([10_000, 0]);
    t.engine.stop();
  });

  it('a clock that moves backwards never produces a negative duration', () => {
    const t = setup();
    t.setNow(at(9, 10));
    t.sample();
    t.setNow(at(9, 10, 5));
    t.engine.flush();

    t.setNow(at(8, 40)); // the system clock was corrected by half an hour
    t.engine.flush();
    t.sample();

    expect(durations(t.repo).every((ms) => ms >= 0)).toBe(true);
    expect(t.repo.getAll()[0].endedAt).toBe(at(9, 10, 5).toISOString());
    expect(t.repo.getAll()).toHaveLength(2);
    t.engine.stop();
  });

  it('without a gap limit the engine behaves exactly as before', () => {
    const repo = new FakeEventRepository();
    let clock = at(9);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();
    engine.emit({ watcher: 'window', app: 'Code' });
    clock = at(17);
    engine.emit({ watcher: 'window', app: 'Code' });
    expect(repo.inserts).toHaveLength(1);
    engine.stop();
  });
});

describe('HeartbeatEngine — stopping ends what was open', () => {
  it('stop() flushes and closes: a later start does not continue the old event', () => {
    const t = setup();
    t.sample('Code');
    t.setNow(at(9, 0, 20));
    t.engine.stop();
    expect(t.engine.openCount).toBe(0);
    expect(t.repo.getAll()[0].endedAt).toBe(at(9, 0, 20).toISOString());

    t.setNow(at(10));
    t.engine.start();
    t.sample('Code');
    t.setNow(at(10, 0, 5));
    t.engine.flush();

    const events = t.repo.getAll();
    expect(events).toHaveLength(2);
    expect(events[0].endedAt).toBe(at(9, 0, 20).toISOString()); // untouched by the second run
    expect(events[1]).toMatchObject({ startedAt: at(10).toISOString(), endedAt: at(10, 0, 5).toISOString() });
    t.engine.stop();
  });

  it('closeOpen() ends the open events now and keeps the engine running', () => {
    const t = setup();
    t.sample('Code');
    t.setNow(at(9, 0, 8));
    t.engine.closeOpen();
    expect(t.engine.openCount).toBe(0);
    expect(t.repo.getAll()[0].endedAt).toBe(at(9, 0, 8).toISOString());

    t.setNow(at(9, 0, 12));
    t.sample('Code');
    expect(t.repo.inserts).toHaveLength(2);
    t.engine.stop();
  });
});

describe('TrackingService — system suspend', () => {
  const watcher: IWatcher = { name: 'window', running: true, start: async () => {}, stop: async () => {} };
  const log = { info: () => {}, warn: () => {}, error: () => {} };

  it('ends the open event at suspend and resumes with a new one — no duplicate, no overlap', async () => {
    const repo = new FakeEventRepository();
    let clock = at(22);
    const engine = new HeartbeatEngine(repo, () => clock, 5000, undefined, MAX_GAP);
    const service = new TrackingService([watcher], engine, log);
    await service.start();

    engine.emit({ watcher: 'window', app: 'Code' });
    clock = at(22, 0, 15);
    service.handleSystemSuspend();

    clock = new Date(2026, 0, 6, 7, 30);
    engine.emit({ watcher: 'window', app: 'Code' });
    clock = new Date(2026, 0, 6, 7, 30, 5);
    engine.flush();

    const events = repo.getAll();
    expect(events).toHaveLength(2);
    expect(events[0].endedAt).toBe(at(22, 0, 15).toISOString());
    expect(Date.parse(events[1].startedAt)).toBeGreaterThanOrEqual(Date.parse(events[0].endedAt));
    expect(service.isRunning).toBe(true);
    await service.stop();
  });

  it('is a no-op while tracking is stopped', () => {
    const repo = new FakeEventRepository();
    const engine = new HeartbeatEngine(repo, () => at(9));
    const service = new TrackingService([watcher], engine, log);
    expect(() => service.handleSystemSuspend()).not.toThrow();
    expect(repo.updates).toHaveLength(0);
  });
});
