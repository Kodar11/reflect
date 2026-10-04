import { describe, it, expect, vi } from 'vitest';
import { TrackingController } from '../../src/background/TrackingController';
import { HeartbeatEngine } from '../../src/tracker/HeartbeatEngine';
import { TrackingService } from '../../src/tracker/TrackingService';
import { FakeEventRepository } from '../tracker/FakeEventRepository';
import { countingWatcher, makeSettings, manualTimers, silentLogger } from './helpers';
import type { AppSettings } from '../../src/background/AppSettings';

const at = (h: number, m = 0, day = 5) => new Date(2026, 9, day, h, m);

/** The real tracker (service + heartbeat engine) under the controller, with a fake clock. */
function setup(initial: Partial<AppSettings> = {}, start = at(9)) {
  let now = start;
  const events = new FakeEventRepository();
  const engine = new HeartbeatEngine(events, () => now, 5000, undefined, 30_000);
  const { watcher, state } = countingWatcher();
  const tracking = new TrackingService([watcher], engine, silentLogger);
  const { repo, store } = makeSettings(initial);
  const timers = manualTimers();
  const pauses: { startedAt: string; endedAt: string }[] = [];
  const build = () =>
    new TrackingController({
      tracking,
      settings: store,
      pauses: { recordPause: (startedAt, endedAt) => pauses.push({ startedAt, endedAt }) },
      nextDayStart: (n) => new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1),
      now: () => now,
      timers,
      logger: silentLogger,
    });
  return {
    controller: build(),
    build,
    tracking,
    engine,
    events,
    watcher: state,
    store,
    repo,
    timers,
    pauses,
    setNow: (d: Date) => {
      now = d;
    },
    sample: (app: string) => engine.emit({ watcher: 'window', app, title: app }),
  };
}

describe('TrackingController — tracking is passive', () => {
  it('starts tracking with the background runtime: no window, no click', async () => {
    const t = setup();
    expect(await t.controller.start()).toEqual({ state: 'running', pausedSince: null, pausedUntil: null });
    expect(t.tracking.isRunning).toBe(true);
    expect(t.watcher.starts).toBe(1);

    t.sample('Code');
    expect(t.events.inserts).toHaveLength(1);
  });
});

describe('TrackingController — pause and resume', () => {
  it('pausing stops the tracker and is persisted; nothing is recorded meanwhile', async () => {
    const t = setup();
    await t.controller.start();
    t.sample('Code');

    const state = await t.controller.pause('1h');
    expect(state).toEqual({ state: 'paused', pausedSince: at(9).toISOString(), pausedUntil: at(10).toISOString() });
    expect(t.tracking.isRunning).toBe(false);
    expect(t.repo.stored?.trackingPause).toEqual({ since: at(9).toISOString(), until: at(10).toISOString() });

    t.setNow(at(9, 30));
    t.sample('Chrome'); // a stray sample while paused goes nowhere
    expect(t.events.inserts).toHaveLength(1);
  });

  it('supports 15 minutes, 1 hour, until tomorrow and until resumed', async () => {
    const t = setup({}, at(22, 30));
    await t.controller.start();
    expect((await t.controller.pause('15m')).pausedUntil).toBe(at(22, 45).toISOString());
    expect((await t.controller.pause('1h')).pausedUntil).toBe(at(23, 30).toISOString());
    expect((await t.controller.pause('tomorrow')).pausedUntil).toBe(at(0, 0, 6).toISOString());
    expect((await t.controller.pause('manual')).pausedUntil).toBeNull();
    // Changing the length of a pause does not restart it.
    expect(t.controller.getState().pausedSince).toBe(at(22, 30).toISOString());
  });

  it('resume restarts tracking cleanly: one tracker, and the paused time belongs to no event', async () => {
    const t = setup();
    await t.controller.start();
    t.sample('Code');

    await t.controller.pause('manual');
    t.setNow(at(11));
    expect(await t.controller.resume()).toEqual({ state: 'running', pausedSince: null, pausedUntil: null });
    expect(t.tracking.isRunning).toBe(true);
    expect(t.repo.stored?.trackingPause).toBeNull();

    // The same app is still in front — but it is a new event, not a two-hour one.
    t.sample('Code');
    expect(t.events.inserts).toHaveLength(2);
    expect(t.events.getAll()[0].endedAt).toBe(at(9).toISOString());
    expect(t.events.inserts[1].startedAt).toBe(at(11).toISOString());

    // The pause is on record, so later readers know data is missing — not that nothing happened.
    expect(t.pauses).toEqual([{ startedAt: at(9).toISOString(), endedAt: at(11).toISOString() }]);
  });

  it('never runs two trackers, however the requests arrive', async () => {
    const t = setup();
    await t.controller.start();
    await Promise.all([
      t.controller.pause('15m'),
      t.controller.resume(),
      t.controller.resume(),
      t.controller.pause('1h'),
      t.controller.resume(),
      t.controller.start(),
    ]);
    expect(t.tracking.isRunning).toBe(true);
    // Every start was preceded by a stop: the watcher was never started twice in a row.
    expect(t.watcher.starts - t.watcher.stops).toBe(1);
    expect(t.watcher.running).toBe(true);
  });

  it('a timed pause ends by itself', async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.pause('15m');
    expect(t.timers.pending).toHaveLength(1);
    expect(t.timers.pending[0].ms).toBe(15 * 60_000);

    t.setNow(at(9, 15));
    t.timers.fire();
    await vi.waitFor(() => expect(t.tracking.isRunning).toBe(true));
    expect(t.controller.getState().state).toBe('running');
    expect(t.pauses).toEqual([{ startedAt: at(9).toISOString(), endedAt: at(9, 15).toISOString() }]);
  });

  it('a pause "until I resume" has no timer and stays until the user ends it', async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.pause('manual');
    expect(t.timers.pending).toHaveLength(0);
    t.setNow(at(9, 0, 9)); // four days later
    expect(t.controller.getState().state).toBe('paused');
    expect(t.tracking.isRunning).toBe(false);
  });

  it('tells listeners about every change', async () => {
    const t = setup();
    const listener = vi.fn();
    t.controller.onChanged(listener);
    await t.controller.start();
    await t.controller.pause('manual');
    await t.controller.resume();
    expect(listener.mock.calls.map(([s]) => s.state)).toEqual(['running', 'paused', 'running']);
  });
});

describe('TrackingController — restart recovery', () => {
  it('a pause survives a restart: the app does not silently start tracking again', async () => {
    const t = setup({ trackingPause: { since: at(8).toISOString(), until: null } });
    expect((await t.controller.start()).state).toBe('paused');
    expect(t.tracking.isRunning).toBe(false);
    expect(t.watcher.starts).toBe(0);
  });

  it('a timed pause that is still running after a restart is honoured and re-armed', async () => {
    const t = setup({ trackingPause: { since: at(8, 30).toISOString(), until: at(9, 30).toISOString() } });
    expect((await t.controller.start()).state).toBe('paused');
    expect(t.timers.pending[0].ms).toBe(30 * 60_000);
  });

  it('a pause that ran out while the app was closed ends at the time it was meant to', async () => {
    const t = setup({ trackingPause: { since: at(20, 0, 4).toISOString(), until: at(21, 0, 4).toISOString() } });
    expect((await t.controller.start()).state).toBe('running');
    expect(t.tracking.isRunning).toBe(true);
    expect(t.repo.stored?.trackingPause).toBeNull();
    // Logged as the hour it covered — not the whole night the app was not running.
    expect(t.pauses).toEqual([{ startedAt: at(20, 0, 4).toISOString(), endedAt: at(21, 0, 4).toISOString() }]);
  });

  it('quitting is neither a pause nor a resume: the stored pause is left alone', async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.pause('manual');
    await t.controller.shutdown();
    expect(t.repo.stored?.trackingPause).not.toBeNull();

    const running = setup();
    await running.controller.start();
    await running.controller.shutdown();
    expect(running.tracking.isRunning).toBe(false);
    expect(running.repo.stored?.trackingPause).toBeNull();

    // Nothing restarts a tracker after shutdown.
    await running.controller.resume();
    await running.controller.pause('15m');
    expect(running.tracking.isRunning).toBe(false);
  });
});

describe('TrackingController — sleep and wake', () => {
  it('sleep is not tracked time: the open event ends at suspend, a new one starts after wake', async () => {
    const t = setup();
    await t.controller.start();
    t.sample('Code');
    // The watcher keeps sampling (every second in production) up to the suspend.
    const suspendAt = new Date(2026, 9, 5, 9, 0, 25);
    t.setNow(new Date(2026, 9, 5, 9, 0, 20));
    t.sample('Code');
    t.setNow(suspendAt);
    t.controller.handleSystemSuspend();

    t.setNow(at(17)); // the lid was closed all day
    await t.controller.handleSystemResume();
    expect(t.tracking.isRunning).toBe(true);
    t.sample('Code');

    const events = t.events.getAll();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ startedAt: at(9).toISOString(), endedAt: suspendAt.toISOString() });
    expect(events[1].startedAt).toBe(at(17).toISOString());
    expect(t.watcher.starts).toBe(1); // the tracker carried on — it was not restarted
  });

  it('a timed pause that ended during sleep is finished on wake, at its own end time', async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.pause('15m');
    t.setNow(at(13)); // slept through the timer
    expect((await t.controller.handleSystemResume()).state).toBe('running');
    expect(t.tracking.isRunning).toBe(true);
    expect(t.pauses).toEqual([{ startedAt: at(9).toISOString(), endedAt: at(9, 15).toISOString() }]);
  });

  it('an expired pause is ended as soon as anyone asks for the state, even if no timer fired', async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.pause('15m');
    t.setNow(at(10));
    expect(t.controller.getState().state).toBe('running');
    await vi.waitFor(() => expect(t.tracking.isRunning).toBe(true));
  });
});

describe('TrackingController — the pause in force', () => {
  it('reports how much of the current pause falls inside a period', async () => {
    const t = setup();
    await t.controller.start();
    expect(t.controller.currentPauseMsBetween(at(0).toISOString(), at(23).toISOString())).toBe(0);

    await t.controller.pause('manual');
    t.setNow(at(10, 30));
    expect(t.controller.currentPauseMsBetween(at(0).toISOString(), at(23).toISOString())).toBe(90 * 60_000);
    expect(t.controller.currentPauseMsBetween(at(10).toISOString(), at(23).toISOString())).toBe(30 * 60_000);
  });
});
