import { describe, it, expect, vi } from 'vitest';
import { WindowWatcher } from '../../src/tracker/watcher/WindowWatcher';
import { FakeEventRepository } from './FakeEventRepository';
import { HeartbeatEngine } from '../../src/tracker/HeartbeatEngine';

/**
 * `WindowWatcher` is tested with an injected fake poll + real heartbeat engine
 * over a fake repository. This proves it (a) forwards samples to the sink on
 * each tick, (b) swallows poll errors without stopping, and (c) stops cleanly.
 */
describe('WindowWatcher', () => {
  it('emits samples to the sink and merges identical runs', async () => {
    const repo = new FakeEventRepository();
    const engine = new HeartbeatEngine(repo);
    engine.start();

    const poll = vi.fn(async () => ({ watcher: 'window' as const, app: 'VS Code', title: 'a' }));

    const w = new WindowWatcher(poll, engine, 10);
    await w.start();

    await new Promise((r) => setTimeout(r, 35));
    await w.stop();
    engine.stop();

    // tick fires immediately on start + several intervals fired within 35ms
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(1);
    // identical runs collapse to a single insert
    expect(repo.inserts.length).toBe(1);
    expect(repo.inserts[0].app).toBe('VS Code');
  });

  it('keeps running when poll throws', async () => {
    const repo = new FakeEventRepository();
    const engine = new HeartbeatEngine(repo);
    engine.start();

    let n = 0;
    const poll = vi.fn(async () => {
      n++;
      if (n === 2) throw new Error('transient');
      return { watcher: 'window' as const, app: 'X', title: 'y' };
    });
    const warn = vi.fn();

    const w = new WindowWatcher(poll, engine, 20, { warn, info: vi.fn(), error: vi.fn() });
    await w.start();
    await new Promise((r) => setTimeout(r, 60));
    await w.stop();
    engine.stop();

    expect(warn).toHaveBeenCalled();
    expect(w.running).toBe(false);
    // watcher still ran multiple polls across the failure
    expect(poll.mock.calls.length).toBeGreaterThan(2);
  });

  it('stop() clears the timer and reports not running', async () => {
    const engine = new HeartbeatEngine(new FakeEventRepository());
    const w = new WindowWatcher(async () => null, engine, 10);
    await w.start();
    expect(w.running).toBe(true);
    await w.stop();
    expect(w.running).toBe(false);
  });
});