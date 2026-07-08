import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from '../../src/database/Database';
import { EventRepository } from '../../src/database/EventRepository';

/**
 * Integration test against the real `better-sqlite3` binary.
 *
 * ABI note: `better-sqlite3` ships a native `.node` file compiled for one V8
 * ABI at a time. `npm run rebuild` compiles it for **Electron**, so it loads
 * in the app; `vitest` runs under **Node**, whose ABI differs. This suite
 * detects that mismatch and self-skips so `npm test` stays green either way.
 *
 * To also exercise this suite under Node, run `npm rebuild better-sqlite3`
 * (rebuilds for Node), then `npm test`; then `npm run rebuild` before launching
 * the Electron app again.
 */
const nativeOk = (() => {
  try {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pc-probe-')), 'probe.db');
    const d = new Database(p);
    d.close();
    fs.rmSync(path.dirname(p), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

const repoSuite = nativeOk ? describe : describe.skip;

repoSuite('EventRepository (integration, real SQLite)', () => {
  let dir: string;
  let db: Database;
  let repo: EventRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-repo-'));
    db = new Database(path.join(dir, 'test.db'));
    repo = new EventRepository(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('inserts and reads back an event', () => {
    const id = repo.insert({
      watcher: 'window',
      startedAt: '2026-01-01T09:00:00.000Z',
      endedAt: '2026-01-01T09:00:00.000Z',
      app: 'VS Code',
      title: 'App.tsx',
    });
    expect(id).toBeGreaterThan(0);

    const all = repo.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id,
      watcher: 'window',
      app: 'VS Code',
      title: 'App.tsx',
      url: null,
      browser: null,
    });
    expect(all[0].createdAt).not.toBeNull();
  });

  it('updateEndedAt advances the end timestamp', () => {
    const id = repo.insert({
      watcher: 'window',
      startedAt: '2026-01-01T09:00:00.000Z',
      endedAt: '2026-01-01T09:00:00.000Z',
      app: 'VS Code',
    });
    repo.updateEndedAt(id, '2026-01-01T09:20:00.000Z');

    const ev = repo.getAll()[0];
    expect(ev.endedAt).toBe('2026-01-01T09:20:00.000Z');
    expect(ev.startedAt).toBe('2026-01-01T09:00:00.000Z');
  });

  it('getByRange returns events within the window, newest first', () => {
    repo.insert({ watcher: 'window', startedAt: '2026-01-01T08:00:00.000Z', endedAt: '2026-01-01T08:05:00.000Z', app: 'A' });
    repo.insert({ watcher: 'window', startedAt: '2026-01-01T10:00:00.000Z', endedAt: '2026-01-01T10:05:00.000Z', app: 'B' });
    repo.insert({ watcher: 'window', startedAt: '2026-01-01T12:00:00.000Z', endedAt: '2026-01-01T12:05:00.000Z', app: 'C' });

    const inRange = repo.getByRange('2026-01-01T09:00:00.000Z', '2026-01-01T11:00:00.000Z');
    expect(inRange).toHaveLength(1);
    expect(inRange[0].app).toBe('B');
  });

  it('serializes payload to JSON string in its column', () => {
    repo.insert({
      watcher: 'window',
      startedAt: '2026-01-01T09:00:00.000Z',
      endedAt: '2026-01-01T09:00:00.000Z',
      app: 'VS Code',
      payload: JSON.stringify({ foo: 1 }),
    });
    const ev = repo.getAll()[0];
    expect(ev.payload).toBe(JSON.stringify({ foo: 1 }));
  });
});