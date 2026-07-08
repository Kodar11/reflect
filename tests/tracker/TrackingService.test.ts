import { describe, it, expect, vi } from 'vitest';
import { TrackingService } from '../../src/tracker/TrackingService';
import { HeartbeatEngine } from '../../src/tracker/HeartbeatEngine';
import { FakeEventRepository } from './FakeEventRepository';
import type { IWatcher } from '../../src/tracker/watcher/IWatcher';

/**
 * `TrackingService` owns lifecycle. The key contract under test: a single
 * watcher failing must NOT prevent siblings from starting, and `stop()` still
 * flushes the engine afterwards. Uses fake watchers so no OS calls happen.
 */
function fakeWatcher(name: string, startThrows = false, stopThrows = false): IWatcher & { started: boolean; stopped: boolean } {
  const state = { started: false, stopped: false };
  return {
    name,
    get running() {
      return state.started && !state.stopped;
    },
    async start() {
      if (startThrows) throw new Error(`boom-${name}`);
      state.started = true;
    },
    async stop() {
      if (stopThrows) throw new Error(`stop-boom-${name}`);
      state.stopped = true;
    },
    ...state,
  } as IWatcher & { started: boolean; stopped: boolean };
}

describe('TrackingService', () => {
  it('starts all watchers and the engine', async () => {
    const repo = new FakeEventRepository();
    const engine = new HeartbeatEngine(repo);
    const a = fakeWatcher('a');
    const b = fakeWatcher('b');
    const svc = new TrackingService([a, b], engine, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });

    await svc.start();
    expect(svc.isRunning).toBe(true);
    expect(svc.health).toEqual({ a: 'running', b: 'running' });

    await svc.stop();
    expect(svc.isRunning).toBe(false);
  });

  it('continues starting other watchers when one throws', async () => {
    const repo = new FakeEventRepository();
    const engine = new HeartbeatEngine(repo);
    const bad = fakeWatcher('bad', true);
    const good = fakeWatcher('good');
    const err = vi.fn();
    const svc = new TrackingService([bad, good], engine, { info: vi.fn(), warn: vi.fn(), error: err });

    await svc.start();
    expect(svc.health).toEqual({ bad: 'failed', good: 'running' });
    expect(err).toHaveBeenCalled();
    await svc.stop();
  });

  it('stop() flushes the engine even after a watcher stop failure', async () => {
    const repo = new FakeEventRepository();
    const engine = new HeartbeatEngine(repo);
    engine.start();
    engine.emit({ watcher: 'window', app: 'X', title: 'y' });
    expect(repo.inserts).toHaveLength(1);

    const bad = fakeWatcher('bad', false, true);
    const svc = new TrackingService([bad], engine, { info: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await svc.start();
    await svc.stop();

    expect(repo.updates.length).toBeGreaterThanOrEqual(1);
  });
});