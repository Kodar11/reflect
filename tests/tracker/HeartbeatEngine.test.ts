import { describe, it, expect } from 'vitest';
import { HeartbeatEngine } from '../../src/tracker/HeartbeatEngine';
import { FakeEventRepository } from './FakeEventRepository';

/**
 * The heartbeat engine is the core invariant of Stage 1: an identical run of
 * samples must collapse to ONE event with `started_at` at the first sample
 * and `ended_at` advanced as time passes. These tests pin that contract using
 * a fake clock and a fake repository — no SQLite, no Electron.
 */

function iso(hr: number, min = 0, sec = 0): string {
  return new Date(2026, 0, 1, hr, min, sec).toISOString();
}

describe('HeartbeatEngine', () => {
  it('inserts a new event on the first sample for a watcher', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();

    engine.emit({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });

    expect(repo.inserts).toHaveLength(1);
    expect(repo.inserts[0]).toMatchObject({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });
    expect(repo.inserts[0].startedAt).toBe(iso(9, 0, 0));
    expect(repo.inserts[0].endedAt).toBe(iso(9, 0, 0));
    engine.stop();
  });

  it('does NOT insert again while identity is unchanged (merge)', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();

    engine.emit({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });
    clock = new Date(2026, 0, 1, 9, 0, 5);
    engine.emit({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });
    clock = new Date(2026, 0, 1, 9, 0, 9);
    engine.emit({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });

    expect(repo.inserts).toHaveLength(1);
    expect(repo.updates).toHaveLength(0);
    engine.stop();
  });

  it('flush() advances ended_at of the open event', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();

    engine.emit({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });
    clock = new Date(2026, 0, 1, 9, 0, 20);

    engine.flush();

    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0].endedAt).toBe(iso(9, 0, 20));
    engine.stop();
  });

  it('creates a new event when identity changes', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();

    engine.emit({ watcher: 'window', app: 'VS Code', title: 'App.tsx' });
    clock = new Date(2026, 0, 1, 9, 5, 0);
    engine.emit({ watcher: 'window', app: 'Chrome', title: 'GitHub' });

    expect(repo.inserts).toHaveLength(2);
    // previous event finalized at the moment of change
    expect(repo.updates).toHaveLength(1);
    expect(repo.updates[0].endedAt).toBe(iso(9, 5, 0));
    // new event starts at the change time
    expect(repo.inserts[1].startedAt).toBe(iso(9, 5, 0));
    engine.stop();
  });

  it('tracks multiple watchers independently', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();

    engine.emit({ watcher: 'window', app: 'VS Code', title: 'a' });
    clock = new Date(2026, 0, 1, 9, 1, 0);
    engine.emit({ watcher: 'browser', browser: 'Chrome', url: 'https://x' });

    expect(repo.inserts).toHaveLength(2);
    expect(repo.inserts[0].watcher).toBe('window');
    expect(repo.inserts[1].watcher).toBe('browser');
    engine.stop();
  });

  it('stop() flushes all open events', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();
    engine.emit({ watcher: 'window', app: 'VS Code', title: 'a' });
    engine.emit({ watcher: 'browser', browser: 'Chrome', url: 'https://x' });
    clock = new Date(2026, 0, 1, 9, 30, 0);

    engine.stop();

    expect(repo.updates).toHaveLength(2);
    expect(repo.updates.every((u) => u.endedAt === iso(9, 30, 0))).toBe(true);
  });

  it('ignores payload when deciding identity', () => {
    const repo = new FakeEventRepository();
    let clock = new Date(2026, 0, 1, 9, 0, 0);
    const engine = new HeartbeatEngine(repo, () => clock);
    engine.start();

    engine.emit({ watcher: 'window', app: 'VS Code', title: 'a', payload: { x: 1 } });
    clock = new Date(2026, 0, 1, 9, 0, 5);
    engine.emit({ watcher: 'window', app: 'VS Code', title: 'a', payload: { x: 2 } });

    expect(repo.inserts).toHaveLength(1);
    expect(repo.inserts[0].payload).toBe(JSON.stringify({ x: 1 }));
    engine.stop();
  });
});